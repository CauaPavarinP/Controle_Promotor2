// Conexão com o PostgreSQL e criação das tabelas.
const { Pool, types } = require('pg');
const config = require('./config');
const { chaveDaLoja, separarCargo } = require('../public/js/planilha-comum');

// O PostgreSQL devolve números decimais (numeric) como texto. Aqui pedimos como número.
types.setTypeParser(1700, (valor) => parseFloat(valor));

let pool;
function obterPool() {
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl });
  return pool;
}

// Roda um comando SQL e devolve as linhas.
async function consulta(sql, parametros = []) {
  const resultado = await obterPool().query(sql, parametros);
  return resultado.rows;
}

// Roda vários comandos como uma coisa só: se um falhar, nenhum é gravado.
async function transacao(funcao) {
  const cliente = await obterPool().connect();
  const rodar = async (sql, parametros = []) => (await cliente.query(sql, parametros)).rows;
  try {
    await cliente.query('BEGIN');
    const retorno = await funcao(rodar);
    await cliente.query('COMMIT');
    return retorno;
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

// "mes" é sempre texto no formato AAAA-MM (ex.: 2026-10). Assim dá para comparar e ordenar direto.
const TABELAS = `
CREATE TABLE IF NOT EXISTS usuarios (
  id          SERIAL PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE,
  nome        TEXT NOT NULL,
  senha_hash  TEXT NOT NULL,
  perfil      TEXT NOT NULL DEFAULT 'usuario' CHECK (perfil IN ('suporte', 'usuario')),
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lojas atendidas (pontos de venda que aparecem nas planilhas de atendimento).
-- "chave" = CNPJ + nome + cidade: duas lojas de uma rede podem ter o mesmo CNPJ (a matriz compra por elas).
CREATE TABLE IF NOT EXISTS lojas (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  cnpj        TEXT,
  chave       TEXT,
  cidade      TEXT NOT NULL DEFAULT '',
  uf          TEXT NOT NULL DEFAULT '',
  endereco    TEXT NOT NULL DEFAULT '',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotores (
  id              SERIAL PRIMARY KEY,
  nome            TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('CLT', 'MEI', 'AGENCIA')),
  agencia         TEXT NOT NULL DEFAULT '',
  telefone        TEXT NOT NULL DEFAULT '',
  salario         NUMERIC(12,2) NOT NULL DEFAULT 0,
  periculosidade  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ajuda_custo     NUMERIC(12,2) NOT NULL DEFAULT 0,
  almoco          NUMERIC(12,2) NOT NULL DEFAULT 0,
  vale_transporte NUMERIC(12,2) NOT NULL DEFAULT 0,
  outros_custos   NUMERIC(12,2) NOT NULL DEFAULT 0,
  observacao      TEXT NOT NULL DEFAULT '',
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS importacoes (
  id          SERIAL PRIMARY KEY,
  tipo        TEXT NOT NULL,
  arquivo     TEXT NOT NULL DEFAULT '',
  usuario     TEXT NOT NULL DEFAULT '',
  linhas      INTEGER NOT NULL DEFAULT 0,
  ignoradas   INTEGER NOT NULL DEFAULT 0,
  total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  meses       TEXT NOT NULL DEFAULT '',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clientes do ERP (FoccoERP), identificados pelo CNPJ: nome, cidade e UF do último arquivo importado.
CREATE TABLE IF NOT EXISTS clientes_erp (
  cnpj          TEXT PRIMARY KEY,
  nome          TEXT NOT NULL DEFAULT '',
  cidade        TEXT NOT NULL DEFAULT '',
  uf            TEXT NOT NULL DEFAULT '',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Faturamento do ERP: um valor por CNPJ, mês e empresa. Liga com as lojas atendidas pelo CNPJ.
CREATE TABLE IF NOT EXISTS faturamento_erp (
  cnpj          TEXT NOT NULL,
  mes           TEXT NOT NULL,
  empresa       TEXT NOT NULL DEFAULT '',
  valor         NUMERIC(14,2) NOT NULL,
  importacao_id INTEGER REFERENCES importacoes(id) ON DELETE SET NULL,
  PRIMARY KEY (cnpj, mes, empresa)
);
CREATE INDEX IF NOT EXISTS faturamento_erp_mes ON faturamento_erp (mes);

-- Atendimento de um promotor em uma loja em um mês: quantas visitas e quanto custou.
-- "custo" vazio (NULL) = usar o custo fixo do cadastro do promotor, dividido pelas visitas.
CREATE TABLE IF NOT EXISTS visitas (
  id            SERIAL PRIMARY KEY,
  promotor_id   INTEGER NOT NULL REFERENCES promotores(id) ON DELETE CASCADE,
  loja_id       INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  mes           TEXT NOT NULL,
  qtd_visitas   INTEGER NOT NULL DEFAULT 0,
  custo         NUMERIC(12,2),
  importacao_id INTEGER REFERENCES importacoes(id) ON DELETE SET NULL,
  UNIQUE (promotor_id, loja_id, mes)
);
`;

// Mudanças feitas depois da primeira versão. Cada comando só age se ainda não foi aplicado,
// então pode rodar toda vez que o sistema inicia sem estragar nada.
const ATUALIZACOES = `
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS codigo        TEXT NOT NULL DEFAULT '';
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS empresa       TEXT NOT NULL DEFAULT '';
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS regiao        TEXT NOT NULL DEFAULT '';
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS admissao      TEXT NOT NULL DEFAULT '';  -- AAAA-MM-DD
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS ajuda_celular NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS gratificacao  NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Tipo novo: Freelancer.
ALTER TABLE promotores DROP CONSTRAINT IF EXISTS promotores_tipo_check;
ALTER TABLE promotores ADD CONSTRAINT promotores_tipo_check CHECK (tipo IN ('CLT', 'MEI', 'AGENCIA', 'FREELANCER'));

-- Duas agências podem ter um promotor com o mesmo nome ("João"). O que não pode repetir é nome + agência + código.
DROP INDEX IF EXISTS promotores_nome_unico;
CREATE UNIQUE INDEX IF NOT EXISTS promotores_identidade ON promotores (lower(nome), lower(agencia), codigo);

ALTER TABLE visitas ADD COLUMN IF NOT EXISTS dias_visita TEXT NOT NULL DEFAULT '';  -- ex.: "Ter, Sex (2x/semana)"
ALTER TABLE visitas ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT '';
ALTER TABLE visitas ADD COLUMN IF NOT EXISTS supervisor  TEXT NOT NULL DEFAULT '';
ALTER TABLE visitas ADD COLUMN IF NOT EXISTS observacao  TEXT NOT NULL DEFAULT '';

-- Cargo do promotor ("Sup ll", "Lider"...), separado do nome. Supervisor não entra no custo dos promotores.
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS cargo      TEXT NOT NULL DEFAULT '';
-- true = veio do cadastro (planilha de cadastro ou tela). false = criado só pela planilha de atendimentos.
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS cadastrado BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE promotores SET cadastrado = TRUE
  WHERE NOT cadastrado AND (salario > 0 OR empresa <> '' OR admissao <> '' OR regiao <> '');

-- Desfazer importação: cópia das linhas que a importação substituiu, para poder restaurar.
-- "restauravel" = a importação guardou essa cópia (as feitas antes desta versão não guardaram).
ALTER TABLE importacoes ADD COLUMN IF NOT EXISTS restauravel BOOLEAN NOT NULL DEFAULT FALSE;
-- Supervisores: cadastro separado dos promotores (só nome, código, cargo e empresa; sem salário nem custo).
-- "chave" = nome sem acento e minúsculo. Ligam-se aos atendimentos pela coluna "Supervisor" da planilha.
CREATE TABLE IF NOT EXISTS supervisores (
  id        SERIAL PRIMARY KEY,
  nome      TEXT NOT NULL,
  chave     TEXT NOT NULL UNIQUE,
  codigo    TEXT NOT NULL DEFAULT '',
  cargo     TEXT NOT NULL DEFAULT '',
  empresa   TEXT NOT NULL DEFAULT '',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Promotor que a importação não conseguiu identificar com certeza:
-- '' = identificado | 'ambiguo' = mais de um parecido no cadastro | 'nao_encontrado' = CLT que não está no cadastro.
ALTER TABLE promotores ADD COLUMN IF NOT EXISTS pendente TEXT NOT NULL DEFAULT '';

-- Ligação feita à mão na tela: o nome do promotor como vem na planilha (+ agência) é este promotor do cadastro.
-- Vale para as próximas importações. "nome" e "agencia" ficam sem acento e minúsculos.
CREATE TABLE IF NOT EXISTS vinculos_promotor (
  nome        TEXT NOT NULL,
  agencia     TEXT NOT NULL,
  promotor_id INTEGER NOT NULL REFERENCES promotores(id) ON DELETE CASCADE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nome, agencia)
);

CREATE TABLE IF NOT EXISTS importacoes_backup (
  importacao_id INTEGER NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  tabela        TEXT NOT NULL,
  dados         JSONB NOT NULL,
  PRIMARY KEY (importacao_id, tabela)
);
`;

// Versão anterior: o faturamento era guardado POR LOJA (tabela "faturamento"), e cada CNPJ do ERP virava uma
// loja. Agora o faturamento é guardado POR CNPJ (tabela "faturamento_erp") e dividido entre as lojas atendidas
// na hora do cálculo. Esta migração converte os dados antigos uma única vez, numa transação só (se algo der
// errado, nada muda). Antes, guarda uma cópia do faturamento antigo em "backup_faturamento_por_loja".
async function migrarFaturamentoPorCnpj() {
  const [{ existe }] = await consulta("SELECT to_regclass('public.faturamento') IS NOT NULL AS existe");
  if (existe) {
    await transacao(async (rodar) => {
      await rodar(`CREATE TABLE IF NOT EXISTS backup_faturamento_por_loja AS
        SELECT f.loja_id, f.mes, f.empresa, f.valor, f.importacao_id, l.nome AS loja_nome, l.cnpj, l.cidade, l.uf
        FROM faturamento f JOIN lojas l ON l.id = f.loja_id`);
      await rodar(`INSERT INTO clientes_erp (cnpj, nome, cidade, uf)
        SELECT DISTINCT ON (l.cnpj) l.cnpj, l.nome, l.cidade, l.uf
        FROM faturamento f JOIN lojas l ON l.id = f.loja_id
        WHERE coalesce(l.cnpj, '') <> '' ORDER BY l.cnpj, l.id
        ON CONFLICT (cnpj) DO NOTHING`);
      await rodar(`INSERT INTO faturamento_erp (cnpj, mes, empresa, valor, importacao_id)
        SELECT l.cnpj, f.mes, f.empresa, sum(f.valor), max(f.importacao_id)
        FROM faturamento f JOIN lojas l ON l.id = f.loja_id
        WHERE coalesce(l.cnpj, '') <> '' GROUP BY l.cnpj, f.mes, f.empresa
        ON CONFLICT DO NOTHING`);
      await rodar('DROP TABLE faturamento');
      // Lojas que só existiam por causa do faturamento (nenhum atendimento): agora são clientes do ERP.
      await rodar('DELETE FROM lojas l WHERE NOT EXISTS (SELECT 1 FROM visitas v WHERE v.loja_id = l.id)');
    });
  }

  // O CNPJ deixa de ser único entre as lojas; quem identifica a loja passa a ser a "chave".
  await consulta('ALTER TABLE lojas DROP CONSTRAINT IF EXISTS lojas_cnpj_key');
  await consulta('ALTER TABLE lojas ADD COLUMN IF NOT EXISTS chave TEXT');
  const semChave = await consulta('SELECT id, nome, cnpj, cidade FROM lojas WHERE chave IS NULL ORDER BY id');
  if (semChave.length) {
    const usadas = new Set((await consulta('SELECT chave FROM lojas WHERE chave IS NOT NULL')).map((l) => l.chave));
    const ids = []; const chaves = [];
    for (const l of semChave) {
      let chave = chaveDaLoja(l.cnpj, l.nome, l.cidade);
      if (usadas.has(chave)) chave = `${chave}#${l.id}`; // nunca deve acontecer, mas não pode travar o sistema
      usadas.add(chave);
      ids.push(l.id); chaves.push(chave);
    }
    await consulta('UPDATE lojas SET chave = t.chave FROM unnest($1::int[], $2::text[]) AS t(id, chave) WHERE lojas.id = t.id', [ids, chaves]);
  }
  await consulta('CREATE UNIQUE INDEX IF NOT EXISTS lojas_chave ON lojas (chave)');
}

// Nomes que vieram com o cargo junto ("NOME - Sup ll"): separa em nome + cargo. Só para CLT e só quando
// o nome não é o próprio nome da agência. Se já existir outro promotor com o nome limpo (mesma agência e
// código), deixa como está para não juntar duas pessoas por engano.
async function separarCargosDosNomes() {
  const candidatos = await consulta("SELECT id, nome, agencia, codigo FROM promotores WHERE tipo = 'CLT' AND cargo = '' AND nome LIKE '% - %' AND nome <> agencia");
  for (const p of candidatos) {
    const { nome, cargo } = separarCargo(p.nome);
    if (!cargo) continue;
    const [outro] = await consulta('SELECT id FROM promotores WHERE lower(nome) = lower($1) AND lower(agencia) = lower($2) AND codigo = $3 AND id <> $4', [nome, p.agencia, p.codigo, p.id]);
    if (outro) { console.warn(`Cargo não separado do promotor ${p.id} ("${p.nome}"): já existe outro com o nome "${nome}".`); continue; }
    await consulta('UPDATE promotores SET nome = $1, cargo = $2 WHERE id = $3', [nome, cargo, p.id]);
  }
}

async function iniciarBanco() {
  await consulta(TABELAS);
  await consulta(ATUALIZACOES);
  await migrarFaturamentoPorCnpj();
  await separarCargosDosNomes();
}

async function fecharBanco() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { consulta, transacao, iniciarBanco, fecharBanco };
