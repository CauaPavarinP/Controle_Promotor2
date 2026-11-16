// Conexão com o PostgreSQL e criação das tabelas.
const { Pool, types } = require('pg');
const config = require('./config');

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

CREATE TABLE IF NOT EXISTS lojas (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  cnpj        TEXT UNIQUE,
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

-- Faturamento de cada loja, um valor por mês e por empresa.
CREATE TABLE IF NOT EXISTS faturamento (
  id            SERIAL PRIMARY KEY,
  loja_id       INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  mes           TEXT NOT NULL,
  empresa       TEXT NOT NULL DEFAULT '',
  valor         NUMERIC(14,2) NOT NULL,
  importacao_id INTEGER REFERENCES importacoes(id) ON DELETE SET NULL,
  UNIQUE (loja_id, mes, empresa)
);

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
`;

async function iniciarBanco() {
  await consulta(TABELAS);
  await consulta(ATUALIZACOES);
}

async function fecharBanco() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { consulta, transacao, iniciarBanco, fecharBanco };
