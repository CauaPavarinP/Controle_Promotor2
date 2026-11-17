// Gravação das importações: faturamento (FoccoERP) e visitas (agências, CLTs, MEIs).
// O navegador já leu o arquivo e somou as linhas (ver public/js/planilha-comum.js). Aqui chegam só os
// "itens" prontos. Mesmo assim conferimos tudo de novo: o servidor nunca confia no que vem do navegador.
const { transacao, consulta } = require('./db');
const {
  mesValido, primeiroNome, ufDe, chaveDaLoja, separarCargo, codigoNormal, normalizar, ehSupervisor, acharPorNome, TIPOS_VALIDOS, CAMPOS_DINHEIRO,
} = require('./planilha');

class ErroDeImportacao extends Error {}

const MAX_ITENS = 300000;
const LOTE = 1000; // quantas linhas gravamos por comando SQL

// Limpa um texto: tira o caractere nulo (o PostgreSQL não aceita) e corta no tamanho máximo.
const texto = (v, tamanho) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, tamanho);

// O maior valor que cabe nas colunas de dinheiro do banco (NUMERIC(14,2)).
const VALOR_MAXIMO = 999999999999.99;

function conferirLoja(loja) {
  if (!loja || typeof loja !== 'object') throw new ErroDeImportacao('Há um registro sem loja nos dados enviados.');
  const cnpj = String(loja?.cnpj ?? '').trim();
  if (cnpj && !/^\d{11,14}$/.test(cnpj)) throw new ErroDeImportacao('CNPJ inválido nos dados enviados.');
  const nome = texto(loja?.nome, 200);
  if (!cnpj && !nome) throw new ErroDeImportacao('Há um registro sem loja nos dados enviados.');
  const cidade = texto(loja.cidade, 100);
  const nomeFinal = nome || `CNPJ ${cnpj}`;
  return {
    // A chave é recalculada aqui (não vale a que veio do navegador): CNPJ + nome + cidade.
    chave: chaveDaLoja(cnpj, nomeFinal, cidade),
    cnpj,
    nome: nomeFinal,
    cidade,
    uf: ufDe(loja.uf) || texto(loja.uf, 40),
    endereco: texto(loja.endereco, 200),
  };
}

function conferirMes(mes) {
  if (!mesValido(mes)) throw new ErroDeImportacao('Mês inválido nos dados enviados.');
  return mes;
}

function conferirNumero(valor, { minimo, nome }) {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < minimo || Math.abs(valor) > VALOR_MAXIMO) {
    throw new ErroDeImportacao(`${nome} inválido nos dados enviados.`);
  }
  return Math.round(valor * 100) / 100;
}

function conferirEnvio(dados) {
  if (!Array.isArray(dados?.itens) || !dados.itens.length) throw new ErroDeImportacao('Nenhuma linha válida no arquivo.');
  if (dados.itens.length > MAX_ITENS) throw new ErroDeImportacao('Arquivo com registros demais para uma importação só. Divida por período.');
  if (dados.itens.some((item) => !item || typeof item !== 'object')) throw new ErroDeImportacao('Os dados enviados estão em formato inválido.');
  // "motivos" = por que linhas foram ignoradas; "avisos" = linhas que entraram com algo a conferir.
  // Vêm do navegador só para registro e para a mensagem final.
  const contagens = (origem) => {
    const limpo = {};
    for (const [frase, quantidade] of Object.entries(origem || {}).slice(0, 20)) {
      if (Number.isInteger(quantidade) && quantidade > 0) limpo[texto(frase, 120)] = quantidade;
    }
    return limpo;
  };
  return { motivos: contagens(dados.motivos), avisos: contagens(dados.avisos) };
}

// Descobre o id de cada loja dos itens, cadastrando as que ainda não existem. A loja é identificada pela
// chave (CNPJ + nome + cidade). Devolve um Map: chave da loja -> id.
// Faz tudo com poucos comandos SQL (um SELECT e INSERTs em lote), porque um arquivo pode trazer milhares de lojas.
async function resolverLojas(rodar, itens, contagem) {
  const porChave = new Map();
  for (const l of await rodar('SELECT id, chave FROM lojas')) porChave.set(l.chave, l.id);
  const ids = new Map();
  const novas = new Map();
  for (const { loja } of itens) {
    if (ids.has(loja.chave) || novas.has(loja.chave)) continue;
    if (porChave.has(loja.chave)) { ids.set(loja.chave, porChave.get(loja.chave)); continue; }
    // A loja já existia sem CNPJ (veio de uma planilha anterior sem ele) e agora chegou com CNPJ:
    // aproveita o mesmo cadastro e grava o CNPJ, para o histórico da loja não se dividir em dois.
    const semCnpj = loja.cnpj ? chaveDaLoja('', loja.nome, loja.cidade) : null;
    if (semCnpj && porChave.has(semCnpj)) {
      const id = porChave.get(semCnpj);
      await rodar('UPDATE lojas SET cnpj = $1, chave = $2 WHERE id = $3', [loja.cnpj, loja.chave, id]);
      porChave.delete(semCnpj);
      porChave.set(loja.chave, id);
      ids.set(loja.chave, id);
      continue;
    }
    novas.set(loja.chave, loja);
  }

  const lista = [...novas.values()];
  for (let i = 0; i < lista.length; i += LOTE) {
    const lote = lista.slice(i, i + LOTE);
    const criadas = await rodar(
      `INSERT INTO lojas (nome, cnpj, chave, cidade, uf, endereco)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       RETURNING id, chave`,
      [lote.map((l) => l.nome), lote.map((l) => l.cnpj || null), lote.map((l) => l.chave), lote.map((l) => l.cidade), lote.map((l) => l.uf), lote.map((l) => l.endereco)],
    );
    for (const criada of criadas) ids.set(criada.chave, criada.id);
  }
  contagem.lojasNovas = lista.length;
  return ids;
}

// Soma os valores e confere se o total cabe no banco (um valor absurdo indica coluna errada escolhida na tela).
function conferirTotal(valor) {
  if (Math.abs(valor) > VALOR_MAXIMO) {
    throw new ErroDeImportacao('O valor somado ficou grande demais. Confira se a coluna de valor escolhida é a certa.');
  }
  return Math.round(valor * 100) / 100;
}

// "restauravel": faturamento e atendimentos guardam cópia do que substituem, então podem ser desfeitos.
async function registrarImportacao(rodar, tipo, arquivo, usuario) {
  const [imp] = await rodar('INSERT INTO importacoes (tipo, arquivo, usuario, restauravel) VALUES ($1, $2, $3, $4) RETURNING id',
    [tipo, texto(arquivo, 200), usuario, tipo !== 'promotores']);
  return imp.id;
}

const NOMES_MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (mes) => `${NOMES_MESES[Number(mes.slice(5)) - 1]}/${mes.slice(0, 4)}`;

// Guarda as linhas que a importação vai apagar, para o "Desfazer" poder restaurá-las.
async function guardarCopia(rodar, importacaoId, tabela, linhas) {
  await rodar('INSERT INTO importacoes_backup (importacao_id, tabela, dados) VALUES ($1, $2, $3::jsonb)', [importacaoId, tabela, JSON.stringify(linhas)]);
}

async function fecharImportacao(rodar, id, resultado) {
  await rodar('UPDATE importacoes SET linhas = $1, ignoradas = $2, total = $3, meses = $4 WHERE id = $5',
    [resultado.importadas, resultado.ignoradas, resultado.total, resultado.meses.join(', '), id]);
}

function montarResultado(registros, { motivos, avisos }, contagem, campoTotal) {
  return {
    importadas: registros.length,
    ignoradas: Object.values(motivos).reduce((a, b) => a + b, 0),
    motivos,
    avisos,
    ...contagem,
    total: conferirTotal(registros.reduce((soma, r) => soma + (r[campoTotal] || 0), 0)),
    meses: [...new Set(registros.map((r) => r.mes))].sort(),
  };
}

// ---------- Faturamento ----------
// Importar substitui o MÊS INTEIRO de cada empresa que o arquivo traz: antes de gravar, apaga todo o
// faturamento daqueles meses e empresas (guardando uma cópia). Assim, um cliente que saiu do arquivo novo
// não fica com o valor antigo. Por isso exporte do Focco sempre o mês inteiro.
function prepararFaturamento(dados) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const loja = conferirLoja(item.loja);
    if (!loja.cnpj) throw new ErroDeImportacao('Há um registro de faturamento sem CNPJ nos dados enviados.');
    return { loja, mes: conferirMes(item.mes), empresa: texto(item.empresa, 60), valor: conferirNumero(item.valor, { minimo: -1e12, nome: 'Valor' }) };
  });
  const pares = new Map();
  for (const i of itens) pares.set(`${i.mes}|${i.empresa}`, { mes: i.mes, empresa: i.empresa });
  return { registro, itens, pares: [...pares.values()].sort((x, y) => x.mes.localeCompare(y.mes) || x.empresa.localeCompare(y.empresa)) };
}

// Linhas atuais do faturamento nos meses + empresas do arquivo.
const escopoDoFaturamento = (rodar, pares, colunas) => rodar(
  `SELECT ${colunas} FROM faturamento_erp f JOIN unnest($1::text[], $2::text[]) AS e(mes, empresa) ON f.mes = e.mes AND f.empresa = e.empresa`,
  [pares.map((p) => p.mes), pares.map((p) => p.empresa)],
);

async function gravarFaturamento(dados, usuario) {
  const { registro, itens, pares } = prepararFaturamento(dados);

  return transacao(async (rodar) => {
    const importacaoId = await registrarImportacao(rodar, 'faturamento', dados.arquivo, usuario);

    // 1) Cópia do que vai ser substituído e 2) apaga o mês inteiro daquelas empresas.
    const antigas = await escopoDoFaturamento(rodar, pares, 'f.cnpj, f.mes, f.empresa, f.valor, f.importacao_id');
    await guardarCopia(rodar, importacaoId, 'faturamento_erp', antigas);
    await rodar(
      `DELETE FROM faturamento_erp f USING unnest($1::text[], $2::text[]) AS e(mes, empresa) WHERE f.mes = e.mes AND f.empresa = e.empresa`,
      [pares.map((p) => p.mes), pares.map((p) => p.empresa)],
    );

    // Clientes do ERP: grava ou atualiza nome, cidade e UF (vale o que veio por último no arquivo).
    const clientes = new Map();
    for (const { loja } of itens) clientes.set(loja.cnpj, loja);
    const existentes = new Set((await rodar('SELECT cnpj FROM clientes_erp WHERE cnpj = ANY($1::text[])', [[...clientes.keys()]])).map((c) => c.cnpj));
    const listaClientes = [...clientes.values()];
    for (let i = 0; i < listaClientes.length; i += LOTE) {
      const lote = listaClientes.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO clientes_erp (cnpj, nome, cidade, uf)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
         ON CONFLICT (cnpj) DO UPDATE SET nome = EXCLUDED.nome, cidade = EXCLUDED.cidade, uf = EXCLUDED.uf, atualizado_em = now()`,
        [lote.map((c) => c.cnpj), lote.map((c) => c.nome), lote.map((c) => c.cidade), lote.map((c) => c.uf)],
      );
    }

    // 3) Grava o arquivo novo, somando por CNPJ + mês + empresa.
    const somas = new Map();
    for (const item of itens) {
      const chave = `${item.loja.cnpj}|${item.mes}|${item.empresa}`;
      if (!somas.has(chave)) somas.set(chave, { cnpj: item.loja.cnpj, mes: item.mes, empresa: item.empresa, valor: 0 });
      somas.get(chave).valor += item.valor;
    }
    const registros = [...somas.values()];
    for (const r of registros) r.valor = conferirTotal(r.valor);
    for (let i = 0; i < registros.length; i += LOTE) {
      const lote = registros.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO faturamento_erp (cnpj, mes, empresa, valor, importacao_id)
         SELECT cnpj, mes, empresa, valor, $5::int FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[]) AS t(cnpj, mes, empresa, valor)`,
        [lote.map((r) => r.cnpj), lote.map((r) => r.mes), lote.map((r) => r.empresa), lote.map((r) => r.valor), importacaoId],
      );
    }
    const contagem = { clientesNovos: listaClientes.filter((c) => !existentes.has(c.cnpj)).length, substituidas: antigas.length };
    const resultado = montarResultado(registros, registro, contagem, 'valor');
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Promotores ----------

// Agência de um promotor (a mesma regra de src/calculo.js): a da planilha de atendimentos ou, para quem
// só está no cadastro, a empresa.
const SQL_AGENCIA = "lower(coalesce(nullif(p.agencia, ''), nullif(p.empresa, ''), 'Sem agência'))";

// Carrega o cadastro de promotores e devolve duas formas de achar "o mesmo promotor" que veio na planilha.
//
// achar (usada no CADASTRO de promotores):
//   1º) mesmo código E mesmo primeiro nome (código sem zeros à esquerda: "06" = "6");
//   2º) mesmo nome e mesma agência.
//
// identificar (usada nos ATENDIMENTOS; nem todo CLT, MEI ou promotor de agência tem código):
//   1º) com código: código + primeiro nome;
//   2º) ligação feita à mão na tela (nome da planilha + agência -> promotor);
//   3º) nome completo + agência (sem acento, sem diferenciar maiúsculas);
//   4º) primeiro nome + agência ou empresa, mas SÓ se houver um único promotor que bata.
//   Com mais de um, não adivinha: devolve "ambiguo" e a lista de candidatos.
async function carregarPromotores(rodar) {
  const porId = new Map();
  const lista = [];
  const incluir = (p) => { porId.set(p.id, p); lista.push(p); };
  for (const p of await rodar('SELECT * FROM promotores ORDER BY id')) incluir(p);
  const vinculos = new Map();
  for (const v of await rodar('SELECT nome, agencia, promotor_id FROM vinculos_promotor')) vinculos.set(`${v.nome}|${v.agencia}`, v.promotor_id);

  const porCodigo = ({ nome, codigo = '' }) => {
    const cod = codigoNormal(codigo);
    const primeiro = primeiroNome(nome);
    return (cod && lista.find((p) => codigoNormal(p.codigo) === cod && primeiroNome(p.nome) === primeiro)) || null;
  };

  const achar = ({ nome, agencia = '', codigo = '' }) => porCodigo({ nome, codigo })
    || lista.find((p) => p.nome.toLowerCase() === nome.toLowerCase() && p.agencia.toLowerCase() === agencia.toLowerCase())
    || null;

  const identificar = ({ nome, agencia = '', codigo = '' }) => {
    const peloCodigo = porCodigo({ nome, codigo });
    if (peloCodigo) return { promotor: peloCodigo };
    const ag = normalizar(agencia);
    const vinculo = vinculos.get(`${normalizar(nome)}|${ag}`);
    if (vinculo && porId.has(vinculo)) return { promotor: porId.get(vinculo) };
    // O próprio promotor pendente de uma importação anterior também conta: assim não duplica a cada importação.
    const completo = lista.find((p) => normalizar(p.nome) === normalizar(nome) && normalizar(p.agencia) === ag);
    if (completo) return { promotor: completo };
    const primeiro = primeiroNome(nome);
    const candidatos = lista.filter((p) => !p.pendente && primeiroNome(p.nome) === primeiro
      && ag && (normalizar(p.agencia) === ag || normalizar(p.empresa) === ag));
    if (candidatos.length === 1) return { promotor: candidatos[0] };
    if (candidatos.length > 1) return { promotor: null, motivo: 'ambiguo', candidatos };
    return { promotor: null, motivo: 'nao_encontrado', candidatos: [] };
  };

  return { porId, lista, achar, identificar, incluir };
}

// Cadastro de promotores com os custos mensais (aba "Promotores CLT" do modelo).
// Quem já existe é atualizado (salário e demais valores passam a ser os da planilha); quem não existe é criado.
// O cargo que vem grudado no nome ("NOME - Sup ll") é separado na coluna "cargo".
function prepararPromotores(dados) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const separado = separarCargo(texto(item.nome, 160));
    const p = {
      nome: texto(separado.nome, 120),
      cargo: texto(item.cargo, 60) || texto(separado.cargo, 60),
      tipo: TIPOS_VALIDOS.includes(item.tipo) ? item.tipo : 'CLT',
      agencia: texto(item.agencia, 120),
      codigo: texto(item.codigo, 30),
      empresa: texto(item.empresa, 120),
      regiao: texto(item.regiao, 120),
      telefone: texto(item.telefone, 40),
      observacao: texto(item.observacao, 500),
      admissao: /^\d{4}-\d{2}-\d{2}$/.test(item.admissao || '') ? item.admissao : '',
    };
    if (!p.nome) throw new ErroDeImportacao('Há um promotor sem nome nos dados enviados.');
    for (const campo of CAMPOS_DINHEIRO) p[campo] = conferirNumero(item[campo] ?? 0, { minimo: 0, nome: 'Valor do cadastro' });
    return p;
  });
  return { registro, itens };
}

// Grava (ou atualiza) um supervisor pelo nome sem acento. Devolve true se for novo.
async function gravarSupervisor(rodar, { nome, codigo = '', cargo = '', empresa = '' }) {
  const [r] = await rodar(
    `INSERT INTO supervisores (nome, chave, codigo, cargo, empresa) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chave) DO UPDATE SET nome = EXCLUDED.nome,
       codigo = CASE WHEN EXCLUDED.codigo <> '' THEN EXCLUDED.codigo ELSE supervisores.codigo END,
       cargo = CASE WHEN EXCLUDED.cargo <> '' THEN EXCLUDED.cargo ELSE supervisores.cargo END,
       empresa = CASE WHEN EXCLUDED.empresa <> '' THEN EXCLUDED.empresa ELSE supervisores.empresa END
     RETURNING (xmax = 0) AS novo`,
    [nome, normalizar(nome), codigo, cargo, empresa],
  );
  return r.novo;
}

async function gravarPromotores(dados, usuario) {
  const { registro, itens: todos } = prepararPromotores(dados);
  // Supervisor não é promotor: entra só no cadastro de supervisores (nome, código, cargo e empresa).
  const supervisores = todos.filter((p) => ehSupervisor(p.cargo));
  const itens = todos.filter((p) => !ehSupervisor(p.cargo));
  const COLUNAS = ['nome', 'cargo', 'tipo', 'agencia', 'codigo', 'empresa', 'regiao', 'admissao', ...CAMPOS_DINHEIRO];
  return transacao(async (rodar) => {
    const importacaoId = await registrarImportacao(rodar, 'promotores', dados.arquivo, usuario);
    const cadastro = await carregarPromotores(rodar);
    const contagem = { promotoresNovos: 0, promotoresAtualizados: 0, supervisoresNovos: 0, supervisoresAtualizados: 0 };
    for (const sup of supervisores) {
      if (await gravarSupervisor(rodar, sup)) contagem.supervisoresNovos++; else contagem.supervisoresAtualizados++;
    }
    let total = 0;
    for (const p of itens) {
      const valores = COLUNAS.map((coluna) => p[coluna]);
      const existente = cadastro.achar(p);
      if (existente) {
        // Mantém a agência que já estava (ex.: veio da planilha de atendimentos) se o cadastro não trouxer.
        valores[COLUNAS.indexOf('agencia')] = p.agencia || existente.agencia;
        const atribuicoes = COLUNAS.map((coluna, i) => `${coluna} = $${i + 1}`).join(', ');
        await rodar(
          `UPDATE promotores SET ${atribuicoes}, cadastrado = TRUE,
             telefone = CASE WHEN $${COLUNAS.length + 1} <> '' THEN $${COLUNAS.length + 1} ELSE telefone END,
             observacao = CASE WHEN $${COLUNAS.length + 2} <> '' THEN $${COLUNAS.length + 2} ELSE observacao END
           WHERE id = $${COLUNAS.length + 3}`,
          [...valores, p.telefone, p.observacao, existente.id],
        );
        Object.assign(existente, p, { agencia: valores[COLUNAS.indexOf('agencia')], cadastrado: true });
        contagem.promotoresAtualizados++;
      } else {
        const marcadores = [...COLUNAS, 'telefone', 'observacao'].map((_, i) => `$${i + 1}`).join(', ');
        const [criado] = await rodar(
          `INSERT INTO promotores (${COLUNAS.join(', ')}, telefone, observacao, cadastrado) VALUES (${marcadores}, TRUE) RETURNING *`,
          [...valores, p.telefone, p.observacao],
        );
        cadastro.incluir(criado);
        contagem.promotoresNovos++;
      }
      total += CAMPOS_DINHEIRO.reduce((soma, campo) => soma + p[campo], 0);
    }
    const resultado = {
      importadas: todos.length,
      ignoradas: Object.values(registro.motivos).reduce((a, b) => a + b, 0),
      ...registro,
      ...contagem,
      total: conferirTotal(total), // soma dos custos mensais dos promotores do arquivo (sem os supervisores)
      meses: [],
    };
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Atendimentos (visitas) ----------
// Importar substitui o MÊS INTEIRO das agências que o arquivo traz: antes de gravar, apaga todos os
// atendimentos daqueles meses feitos pelos promotores dessas agências (guardando uma cópia).
// É por agência, e não o mês de todo mundo, porque cada agência manda o próprio arquivo: importar o
// arquivo da agência A não pode apagar o que veio no arquivo da agência B.
function prepararVisitas(dados) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const p = item.promotor || {};
    const promotor = Number.isInteger(p.id) && p.id > 0
      ? { id: p.id }
      : { nome: texto(p.nome, 120), tipo: TIPOS_VALIDOS.includes(p.tipo) ? p.tipo : 'AGENCIA', agencia: texto(p.agencia, 120), codigo: texto(p.codigo, 30) };
    if (!promotor.id && !promotor.nome) throw new ErroDeImportacao('Há um registro sem promotor nos dados enviados.');
    if (!Number.isInteger(item.visitas) || item.visitas < 0 || item.visitas > 9999) throw new ErroDeImportacao('Quantidade de visitas inválida nos dados enviados.');
    return {
      promotor,
      loja: conferirLoja(item.loja),
      mes: conferirMes(item.mes),
      visitas: item.visitas,
      custo: item.custo === null || item.custo === undefined ? null : conferirNumero(item.custo, { minimo: 0, nome: 'Custo' }),
      dias: texto(item.dias, 80),
      status: texto(item.status, 30),
      supervisor: texto(item.supervisor, 80),
      observacao: texto(item.observacao, 400),
    };
  });
  return { registro, itens, meses: [...new Set(itens.map((i) => i.mes))].sort() };
}

// Descobre o promotor de cada item (sem criar nada) e o "escopo" que será substituído:
// meses do arquivo + agências do arquivo + promotores do arquivo.
function escopoDasVisitas(itens, cadastro) {
  const agencias = new Set();
  const ids = new Set();
  const encontrados = new Map(); // item.promotor -> promotor do banco (ou null)
  for (const { promotor: p } of itens) {
    if (encontrados.has(p)) continue;
    const achado = p.id ? cadastro.porId.get(p.id) || null : cadastro.identificar(p).promotor;
    encontrados.set(p, achado);
    // O promotor achado entra pelo id dele. As agências vêm SÓ do texto do arquivo: a agência que o promotor
    // tem no banco pode ser de outra empresa (CLT achado pelo código), e não pode ter o mês apagado.
    if (achado) ids.add(achado.id);
    // Linha sem agência (ex.: MEI): entra só o próprio promotor (pelo id), nunca o grupo "Sem agência" inteiro,
    // senão o arquivo de um MEI apagaria o mês dos outros MEIs.
    if (!p.id && p.agencia) agencias.add(p.agencia.toLowerCase());
  }
  return { agencias: [...agencias], ids: [...ids], encontrados };
}

const SQL_ESCOPO_VISITAS = `FROM visitas v WHERE v.mes = ANY($1::text[])
  AND (v.promotor_id = ANY($2::int[]) OR v.promotor_id IN (SELECT p.id FROM promotores p WHERE ${SQL_AGENCIA} = ANY($3::text[])))`;

async function gravarVisitas(dados, usuario) {
  const { registro, itens, meses } = prepararVisitas(dados);

  return transacao(async (rodar) => {
    const contagem = { lojasNovas: 0, promotoresNovos: 0 };
    const lojas = await resolverLojas(rodar, itens, contagem);
    const importacaoId = await registrarImportacao(rodar, 'visitas', dados.arquivo, usuario);
    const cadastro = await carregarPromotores(rodar);
    const escopo = escopoDasVisitas(itens, cadastro);

    // Promotor de cada item: o que já existe ou um novo. Conta quem veio com código e não achou cadastro.
    const codigosSemCadastro = new Set();
    const naoIdentificados = new Set();
    const promotores = new Map();
    const acharPromotor = async (p) => {
      const chave = p.id ? `id:${p.id}` : `${codigoNormal(p.codigo)}|${p.nome.toLowerCase()}|${p.agencia.toLowerCase()}`;
      if (promotores.has(chave)) return promotores.get(chave);
      let id;
      if (p.id) {
        if (!cadastro.porId.has(p.id)) throw new ErroDeImportacao('O promotor escolhido não existe mais.');
        id = p.id;
      } else {
        const { promotor: existente, motivo } = cadastro.identificar(p);
        if (p.codigo && !(existente && existente.cadastrado)) codigosSemCadastro.add(`${codigoNormal(p.codigo)}|${primeiroNome(p.nome)}`);
        if (existente && existente.pendente) naoIdentificados.add(existente.id);
        if (existente) {
          id = existente.id;
          // Promotor que veio só do cadastro (sem agência): passa a ter a agência da planilha de atendimentos.
          if (!existente.agencia && p.agencia) {
            await rodar('UPDATE promotores SET agencia = $1 WHERE id = $2', [p.agencia, id]);
            existente.agencia = p.agencia;
          }
        } else {
          // Não identificado. Fica "pendente" (aparece no aviso e pode ser ligado à mão na tela) quando:
          //  - há mais de um parecido no cadastro (não adivinhamos), ou
          //  - é CLT e não está no cadastro (CLT deveria estar; sem cadastro não há salário).
          // Promotor de agência, MEI ou freelancer que não existe ainda é só um promotor novo.
          const pendente = motivo === 'ambiguo' || p.tipo === 'CLT' ? motivo : '';
          const [criado] = await rodar('INSERT INTO promotores (nome, tipo, agencia, codigo, pendente) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [p.nome, p.tipo, p.agencia, p.codigo, pendente]);
          cadastro.incluir(criado);
          id = criado.id;
          if (pendente) naoIdentificados.add(id);
          contagem.promotoresNovos++;
        }
      }
      promotores.set(chave, id);
      return id;
    };

    const somas = new Map();
    for (const item of itens) {
      const promotorId = await acharPromotor(item.promotor);
      const lojaId = lojas.get(item.loja.chave);
      const chave = `${promotorId}|${lojaId}|${item.mes}`;
      if (!somas.has(chave)) somas.set(chave, { promotorId, lojaId, mes: item.mes, visitas: 0, custo: null, dias: '', status: '', supervisor: '', observacao: '' });
      const soma = somas.get(chave);
      soma.visitas += item.visitas;
      if (item.custo !== null) soma.custo = (soma.custo || 0) + item.custo;
      for (const campo of ['dias', 'status', 'supervisor', 'observacao']) soma[campo] = soma[campo] || item[campo];
    }
    const registros = [...somas.values()];
    for (const r of registros) {
      if (r.custo !== null) r.custo = conferirTotal(r.custo);
      if (r.visitas > 100000) throw new ErroDeImportacao('Quantidade de visitas grande demais. Confira a coluna de visitas.');
    }

    // Cópia do que vai ser substituído e apaga o mês inteiro das agências do arquivo.
    const ids = [...new Set([...escopo.ids, ...promotores.values()])];
    const parametros = [meses, ids, escopo.agencias];
    const antigas = await rodar(`SELECT v.* ${SQL_ESCOPO_VISITAS}`, parametros);
    await guardarCopia(rodar, importacaoId, 'visitas', antigas);
    await rodar(`DELETE ${SQL_ESCOPO_VISITAS}`, parametros);

    for (let i = 0; i < registros.length; i += LOTE) {
      const lote = registros.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita, status, supervisor, observacao, importacao_id)
         SELECT promotor_id, loja_id, mes, qtd, custo, dias, status, supervisor, observacao, $10::int
         FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS t(promotor_id, loja_id, mes, qtd, custo, dias, status, supervisor, observacao)`,
        [lote.map((r) => r.promotorId), lote.map((r) => r.lojaId), lote.map((r) => r.mes), lote.map((r) => r.visitas), lote.map((r) => r.custo),
          lote.map((r) => r.dias), lote.map((r) => r.status), lote.map((r) => r.supervisor), lote.map((r) => r.observacao), importacaoId],
      );
    }
    if (codigosSemCadastro.size) registro.avisos['Promotor com código que não está no cadastro (sem salário para calcular o custo)'] = codigosSemCadastro.size;
    if (naoIdentificados.size) registro.avisos['Promotor não identificado (ligue à mão na tela Promotores)'] = naoIdentificados.size;
    // Supervisor da planilha que não acha ninguém no cadastro de supervisores (nome completo ou primeiro nome único).
    const supervisores = await rodar('SELECT id, nome FROM supervisores');
    const semCadastro = new Set(itens.map((i) => i.supervisor).filter((nome) => nome && !acharPorNome(nome, supervisores)).map(normalizar));
    if (semCadastro.size) registro.avisos['Supervisor da planilha que não está no cadastro de supervisores'] = semCadastro.size;
    const resultado = montarResultado(registros, registro, { ...contagem, substituidas: antigas.length }, 'custo');
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Prévia: o que a importação vai substituir ----------
// Chamada antes de gravar, com os mesmos dados. Não grava nada. Devolve a mensagem para a pessoa confirmar.
async function previaDaImportacao(dados) {
  const tipo = dados && dados.tipo;
  if (tipo === 'faturamento') {
    const { pares } = prepararFaturamento(dados);
    const atuais = await escopoDoFaturamento(consulta, pares, 'f.mes, f.empresa');
    const linhas = pares.map((par) => ({
      ...par, registros: atuais.filter((a) => a.mes === par.mes && a.empresa === par.empresa).length,
    }));
    return {
      linhas,
      mensagem: linhas.map((l) => `Isto vai substituir todo o mês ${rotuloMes(l.mes)}${l.empresa ? ` da empresa ${l.empresa}` : ''} (${l.registros} registros atuais).`).join('\n'),
    };
  }
  if (tipo === 'visitas') {
    const { itens, meses } = prepararVisitas(dados);
    const escopo = escopoDasVisitas(itens, await carregarPromotores(consulta));
    const atuais = await consulta(`SELECT v.mes, count(*)::int AS n ${SQL_ESCOPO_VISITAS} GROUP BY v.mes`, [meses, escopo.ids, escopo.agencias]);
    const linhas = meses.map((mes) => ({ mes, registros: (atuais.find((a) => a.mes === mes) || { n: 0 }).n }));
    const agencias = [...new Set(itens.filter((i) => !i.promotor.id).map((i) => i.promotor.agencia || 'Sem agência'))];
    const quem = agencias.length ? (agencias.length > 3 ? `das ${agencias.length} agências do arquivo` : `da(s) agência(s) ${agencias.join(', ')}`) : 'do promotor escolhido';
    return {
      linhas,
      mensagem: linhas.map((l) => `Isto vai substituir todo o mês ${rotuloMes(l.mes)} ${quem} (${l.registros} registros atuais, inclusive os lançados à mão na tela).`).join('\n'),
    };
  }
  if (tipo === 'promotores') {
    const { itens: todos } = prepararPromotores(dados);
    const itens = todos.filter((p) => !ehSupervisor(p.cargo));
    const supervisores = todos.length - itens.length;
    const cadastro = await carregarPromotores(consulta);
    const atualizados = itens.filter((p) => cadastro.achar(p)).length;
    return {
      linhas: [],
      mensagem: `Isto vai atualizar ${atualizados} promotor(es) já cadastrado(s) (salário e adicionais passam a ser os do arquivo) e criar ${itens.length - atualizados} novo(s).`
        + `${supervisores ? ` ${supervisores} supervisor(es) vão para o cadastro de supervisores (sem salário nem custo).` : ''}`
        + ' A importação do cadastro não pode ser desfeita.',
    };
  }
  throw new ErroDeImportacao('Tipo de importação inválido.');
}

// ---------- Desfazer ----------
// Só a importação mais recente de cada mês (e tipo) pode ser desfeita: desfazer uma mais antiga
// restauraria dados por cima de uma importação mais nova.
const mesesDe = (imp) => String(imp.meses || '').split(', ').filter(Boolean);

function motivoParaNaoDesfazer(imp, todas) {
  if (imp.tipo === 'promotores') return 'A importação do cadastro de promotores não pode ser desfeita. Corrija o promotor na tela ou importe o cadastro de novo.';
  const meses = new Set(mesesDe(imp));
  const maisNova = todas.find((o) => o.id > imp.id && o.tipo === imp.tipo && mesesDe(o).some((m) => meses.has(m)));
  if (maisNova) return 'Só dá para desfazer a importação mais recente de cada mês. Desfaça antes as importações mais novas desses meses.';
  return '';
}

async function listarImportacoes() {
  const todas = await consulta('SELECT * FROM importacoes ORDER BY id DESC');
  return todas.slice(0, 30).map((imp) => {
    const motivo = motivoParaNaoDesfazer(imp, todas);
    return { ...imp, podeDesfazer: !motivo, motivoNaoDesfaz: motivo };
  });
}

class NaoEncontrado extends Error {}

// Apaga o que a importação gravou e restaura o que ela tinha substituído, numa transação só.
// Importação antiga (sem cópia): o dado anterior não volta, então só apaga se a pessoa digitar "APAGAR".
async function desfazerImportacao(id, confirmacao = '') {
  return transacao(async (rodar) => {
    const [imp] = await rodar('SELECT * FROM importacoes WHERE id = $1 FOR UPDATE', [id]);
    if (!imp) throw new NaoEncontrado('Importação não encontrada.');
    if (!imp.restauravel && imp.tipo !== 'promotores' && confirmacao !== 'APAGAR') {
      throw new ErroDeImportacao('Esta importação é de antes da cópia de segurança: desfazer só apaga, e o dado anterior não volta. Para apagar mesmo assim, digite APAGAR.');
    }
    const motivo = motivoParaNaoDesfazer(imp, await rodar('SELECT id, tipo, meses FROM importacoes'));
    if (motivo) throw new ErroDeImportacao(motivo);
    const tabela = { faturamento: 'faturamento_erp', visitas: 'visitas' }[imp.tipo];
    const apagados = await rodar(`DELETE FROM ${tabela} WHERE importacao_id = $1 RETURNING 1`, [id]);
    const [copia] = await rodar('SELECT dados FROM importacoes_backup WHERE importacao_id = $1 AND tabela = $2', [id, tabela]);
    let restaurados = [];
    if (copia) {
      // A importação de origem das linhas restauradas pode ter sido apagada: nesse caso fica sem origem.
      restaurados = imp.tipo === 'faturamento'
        ? await rodar(
          `INSERT INTO faturamento_erp (cnpj, mes, empresa, valor, importacao_id)
           SELECT r.cnpj, r.mes, r.empresa, r.valor, (SELECT i.id FROM importacoes i WHERE i.id = r.importacao_id)
           FROM jsonb_to_recordset($1::jsonb) AS r(cnpj text, mes text, empresa text, valor numeric, importacao_id int)
           ON CONFLICT DO NOTHING RETURNING 1`, [JSON.stringify(copia.dados)])
        : await rodar(
          `INSERT INTO visitas (id, promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita, status, supervisor, observacao, importacao_id)
           SELECT r.id, r.promotor_id, r.loja_id, r.mes, r.qtd_visitas, r.custo, coalesce(r.dias_visita, ''), coalesce(r.status, ''),
                  coalesce(r.supervisor, ''), coalesce(r.observacao, ''), (SELECT i.id FROM importacoes i WHERE i.id = r.importacao_id)
           FROM jsonb_to_recordset($1::jsonb) AS r(id int, promotor_id int, loja_id int, mes text, qtd_visitas int, custo numeric,
                dias_visita text, status text, supervisor text, observacao text, importacao_id int)
           WHERE EXISTS (SELECT 1 FROM promotores p WHERE p.id = r.promotor_id) AND EXISTS (SELECT 1 FROM lojas l WHERE l.id = r.loja_id)
           ON CONFLICT DO NOTHING RETURNING 1`, [JSON.stringify(copia.dados)]);
    }
    await rodar('DELETE FROM importacoes WHERE id = $1', [id]); // a cópia vai junto (ON DELETE CASCADE)
    return { registros: apagados.length, restaurados: restaurados.length, semCopia: !imp.restauravel };
  });
}

module.exports = {
  gravarFaturamento, gravarVisitas, gravarPromotores, gravarSupervisor, previaDaImportacao, listarImportacoes, desfazerImportacao,
  ErroDeImportacao, NaoEncontrado,
};
