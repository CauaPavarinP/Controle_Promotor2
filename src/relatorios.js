// Busca os dados do período no banco e aplica as regras de cálculo (src/calculo.js).
const config = require('./config');
const { consulta } = require('./db');
const { calcular, custoFixo, percentual, situacao, CAMPOS_CUSTO } = require('./calculo');
const { mesValido } = require('./planilha');
const { ErroDeValidacao } = require('./auth');

function lerPeriodo(query) {
  const { de, ate } = query;
  if (!mesValido(de) || !mesValido(ate)) throw new ErroDeValidacao('Informe o período (mês inicial e final).');
  if (de > ate) throw new ErroDeValidacao('O mês inicial não pode ser depois do mês final.');
  return { de, ate };
}

async function carregar({ de, ate }, empresa = '') {
  const [promotores, lojas, visitas, faturamentos] = await Promise.all([
    consulta('SELECT * FROM promotores'),
    consulta('SELECT id, nome, cnpj, cidade, uf FROM lojas'),
    consulta('SELECT id, promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita FROM visitas WHERE mes BETWEEN $1 AND $2', [de, ate]),
    consulta("SELECT loja_id, mes, valor FROM faturamento WHERE mes BETWEEN $1 AND $2 AND ($3 = '' OR empresa = $3)", [de, ate, empresa]),
  ]);
  return { ...calcular({ promotores, lojas, visitas, faturamentos, meta: config.meta }), cadastro: promotores };
}

const contem = (texto, busca) => String(texto || '').toLowerCase().includes(busca);

async function resumo(query) {
  return (await carregar(lerPeriodo(query))).resumo;
}

// Lojas com faturamento e/ou visitas no período.
async function faturamentoPorLoja(query) {
  const { lojas } = await carregar(lerPeriodo(query), String(query.empresa || ''));
  const busca = String(query.busca || '').trim().toLowerCase();
  const buscaDigitos = busca.replace(/\D/g, '');
  const filtradas = lojas
    .filter((l) => !busca || contem(l.loja.nome, busca) || contem(l.loja.cidade, busca) || (buscaDigitos && contem(l.loja.cnpj, buscaDigitos)))
    .filter((l) => !query.situacao || l.situacao === query.situacao)
    .sort((a, b) => b.faturamento - a.faturamento);
  const soma = (campo) => Math.round(filtradas.reduce((s, l) => s + l[campo], 0) * 100) / 100;
  return { meta: config.meta, lojas: filtradas, totais: { faturamento: soma('faturamento'), custo: soma('custo'), visitas: soma('visitas') } };
}

// Todos os promotores cadastrados, com os números do período (zerados para quem não teve visita).
async function listaDePromotores(query) {
  const { promotores, cadastro } = await carregar(lerPeriodo(query));
  const calculados = new Map(promotores.map((p) => [p.promotor.id, p]));
  const busca = String(query.busca || '').trim().toLowerCase();
  const lista = cadastro
    .map((p) => {
      const c = calculados.get(p.id);
      return {
        id: p.id, nome: p.nome, tipo: p.tipo, agencia: p.agencia, empresa: p.empresa, codigo: p.codigo, ativo: p.ativo,
        qtdLojas: c ? c.qtdLojas : 0,
        visitas: c ? c.visitas : 0,
        custo: c ? c.custo : 0,
        faturamento: c ? c.faturamento : 0,
        percentual: c ? c.percentual : null,
        situacao: c ? c.situacao : 'sem_dados',
      };
    })
    .filter((p) => !busca || contem(p.nome, busca) || contem(p.agencia, busca) || contem(p.empresa, busca) || p.codigo === busca)
    .filter((p) => !query.tipo || p.tipo === query.tipo)
    .filter((p) => !query.agencia || p.agencia === query.agencia || p.empresa === query.agencia)
    .filter((p) => !query.situacao || p.situacao === query.situacao)
    .filter((p) => !query.ativo || String(p.ativo) === query.ativo)
    // Primeiro quem mais estoura a meta; quem não tem percentual vai para o fim.
    .sort((a, b) => (b.percentual ?? -1) - (a.percentual ?? -1) || a.nome.localeCompare(b.nome));
  return { meta: config.meta, promotores: lista };
}

async function detalheDoPromotor(id, query) {
  const { promotores, cadastro } = await carregar(lerPeriodo(query));
  const promotor = cadastro.find((p) => p.id === id);
  if (!promotor) return null;
  const c = promotores.find((p) => p.promotor.id === id);
  return {
    meta: config.meta,
    promotor: { ...promotor, custoFixo: custoFixo(promotor) },
    visitas: c ? c.visitas : 0,
    custo: c ? c.custo : 0,
    faturamento: c ? c.faturamento : 0,
    custoSemLoja: c ? c.custoSemLoja : 0,
    percentual: c ? c.percentual : null,
    situacao: c ? c.situacao : 'sem_dados',
    lojas: c ? c.lojas : [],
  };
}

// Tudo sobre uma loja no período: faturamento mês a mês e os promotores que a atendem.
async function detalheDaLoja(id, query) {
  const periodo = lerPeriodo(query);
  const [[loja], faturamentos, calculado] = await Promise.all([
    consulta('SELECT id, nome, cnpj, cidade, uf, endereco FROM lojas WHERE id = $1', [id]),
    consulta('SELECT mes, empresa, valor FROM faturamento WHERE loja_id = $1 AND mes BETWEEN $2 AND $3 ORDER BY mes, empresa', [id, periodo.de, periodo.ate]),
    carregar(periodo),
  ]);
  if (!loja) return null;

  // Promotores que atendem a loja (cada um com as visitas, o custo e o faturamento dos meses em que atendeu).
  const promotores = [];
  const custoPorMes = new Map();
  for (const p of calculado.promotores) {
    const naLoja = p.lojas.find((l) => l.loja.id === id);
    if (!naLoja) continue;
    promotores.push({
      id: p.promotor.id, nome: p.promotor.nome, tipo: p.promotor.tipo, agencia: p.promotor.agencia || p.promotor.empresa,
      visitas: naLoja.visitas, dias: naLoja.dias, custo: naLoja.custo, faturamento: naLoja.faturamento,
      percentual: naLoja.percentual, situacao: naLoja.situacao,
    });
    for (const at of naLoja.atendimentos) custoPorMes.set(at.mes, (custoPorMes.get(at.mes) || 0) + at.custo);
  }
  promotores.sort((a, b) => b.custo - a.custo);

  // Uma linha por mês: faturamento (somando as empresas), custo dos promotores e o percentual do mês.
  const meses = new Map();
  const linhaDoMes = (mes) => {
    if (!meses.has(mes)) meses.set(mes, { mes, faturamento: 0, custo: 0, empresas: [] });
    return meses.get(mes);
  };
  for (const f of faturamentos) {
    const linha = linhaDoMes(f.mes);
    linha.faturamento += f.valor;
    linha.empresas.push({ empresa: f.empresa, valor: f.valor });
  }
  for (const [mes, custo] of custoPorMes) linhaDoMes(mes).custo += custo;
  const porMes = [...meses.values()].sort((a, b) => b.mes.localeCompare(a.mes)).map((m) => {
    const faturamento = Math.round(m.faturamento * 100) / 100;
    const custo = Math.round(m.custo * 100) / 100;
    return {
      ...m, faturamento, custo,
      percentual: custo > 0 ? percentual(custo, faturamento) : null,
      situacao: custo > 0 ? situacao(custo, faturamento, config.meta) : 'sem_promotor',
    };
  });

  const total = calculado.lojas.find((l) => l.loja.id === id);
  return {
    meta: config.meta,
    loja,
    faturamento: total ? total.faturamento : 0,
    custo: total ? total.custo : 0,
    visitas: total ? total.visitas : 0,
    percentual: total && total.qtdPromotores ? total.percentual : null,
    situacao: total ? total.situacao : 'sem_dados',
    porMes,
    promotores,
  };
}

// ----- Cadastro de promotor -----

function dinheiro(valor, rotulo) {
  const numero = valor === undefined || valor === '' || valor === null ? 0 : Number(valor);
  if (!Number.isFinite(numero) || numero < 0 || numero > 9999999) throw new ErroDeValidacao(`Valor inválido em "${rotulo}".`);
  return Math.round(numero * 100) / 100;
}

function validarPromotor(dados) {
  const nome = String(dados.nome || '').trim();
  if (!nome) throw new ErroDeValidacao('Informe o nome do promotor.');
  if (!['CLT', 'MEI', 'AGENCIA', 'FREELANCER'].includes(dados.tipo)) throw new ErroDeValidacao('Escolha o tipo: CLT, MEI, Agência ou Freelancer.');
  const admissao = String(dados.admissao || '').trim();
  if (admissao && !/^\d{4}-\d{2}-\d{2}$/.test(admissao)) throw new ErroDeValidacao('Data de admissão inválida.');
  const limpo = {
    nome,
    tipo: dados.tipo,
    agencia: String(dados.agencia || '').trim(),
    codigo: String(dados.codigo || '').trim(),
    empresa: String(dados.empresa || '').trim(),
    regiao: String(dados.regiao || '').trim(),
    admissao,
    telefone: String(dados.telefone || '').trim(),
    observacao: String(dados.observacao || '').trim(),
    ativo: dados.ativo === undefined ? true : Boolean(dados.ativo),
  };
  for (const campo of CAMPOS_CUSTO) limpo[campo] = dinheiro(dados[campo], campo);
  return limpo;
}

const COLUNAS_PROMOTOR = ['nome', 'tipo', 'agencia', 'codigo', 'empresa', 'regiao', 'admissao', 'telefone', 'observacao', 'ativo', ...CAMPOS_CUSTO];

async function salvarPromotor(id, dados) {
  const p = validarPromotor(dados);
  const [repetido] = await consulta(
    'SELECT id FROM promotores WHERE lower(nome) = lower($1) AND lower(agencia) = lower($2) AND codigo = $3 AND id <> $4',
    [p.nome, p.agencia, p.codigo, id || 0],
  );
  if (repetido) throw new ErroDeValidacao('Já existe um promotor com esse nome, agência e código.');
  const valores = COLUNAS_PROMOTOR.map((c) => p[c]);
  if (id) {
    const atribuicoes = COLUNAS_PROMOTOR.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const linhas = await consulta(`UPDATE promotores SET ${atribuicoes} WHERE id = $${valores.length + 1} RETURNING id`, [...valores, id]);
    if (!linhas.length) throw new ErroDeValidacao('Promotor não encontrado.');
    return id;
  }
  const marcadores = COLUNAS_PROMOTOR.map((_, i) => `$${i + 1}`).join(', ');
  const [criado] = await consulta(`INSERT INTO promotores (${COLUNAS_PROMOTOR.join(', ')}) VALUES (${marcadores}) RETURNING id`, valores);
  return criado.id;
}

// Lançamento manual de um atendimento (promotor + loja + mês). Se já existir, substitui.
async function salvarVisita({ promotorId, lojaId, mes, visitas, custo }) {
  if (!mesValido(mes)) throw new ErroDeValidacao('Informe o mês.');
  const qtd = Number(visitas);
  if (!Number.isInteger(qtd) || qtd < 0 || qtd > 999) throw new ErroDeValidacao('Quantidade de visitas inválida.');
  const valor = custo === '' || custo === null || custo === undefined ? null : dinheiro(custo, 'custo');
  const [[promotor], [loja]] = await Promise.all([
    consulta('SELECT id FROM promotores WHERE id = $1', [Number(promotorId) || 0]),
    consulta('SELECT id FROM lojas WHERE id = $1', [Number(lojaId) || 0]),
  ]);
  if (!promotor) throw new ErroDeValidacao('Promotor não encontrado.');
  if (!loja) throw new ErroDeValidacao('Escolha uma loja da lista.');
  await consulta(
    `INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (promotor_id, loja_id, mes) DO UPDATE SET qtd_visitas = EXCLUDED.qtd_visitas, custo = EXCLUDED.custo, importacao_id = NULL`,
    [promotor.id, loja.id, mes, qtd, valor],
  );
}

// Listas usadas nos filtros das telas. É chamada em toda troca de tela, então traz só o que é pequeno.
async function opcoes() {
  const [mesesFat, mesesVis, empresas, agencias] = await Promise.all([
    consulta('SELECT DISTINCT mes FROM faturamento ORDER BY mes'),
    consulta('SELECT DISTINCT mes FROM visitas ORDER BY mes'),
    consulta("SELECT DISTINCT empresa FROM faturamento WHERE empresa <> '' ORDER BY empresa"),
    consulta("SELECT agencia FROM promotores WHERE agencia <> '' UNION SELECT empresa FROM promotores WHERE empresa <> '' ORDER BY 1"),
  ]);
  return {
    meta: config.meta,
    // Meses que têm cada tipo de dado. O Resumo só faz sentido num mês que tenha os dois.
    mesesFaturamento: mesesFat.map((m) => m.mes),
    mesesAtendimentos: mesesVis.map((m) => m.mes),
    meses: [...new Set([...mesesFat, ...mesesVis].map((m) => m.mes))].sort(),
    empresas: empresas.map((e) => e.empresa),
    agencias: agencias.map((a) => a.agencia),
  };
}

// Listas grandes, pedidas só pela tela que precisa delas (antes vinham junto das opções e pesavam em toda tela).
const listaDeLojas = () => consulta('SELECT id, nome, cnpj, cidade FROM lojas ORDER BY nome');
const nomesDosPromotores = () => consulta('SELECT id, nome, tipo, agencia FROM promotores WHERE ativo ORDER BY nome');

module.exports = { resumo, faturamentoPorLoja, listaDePromotores, detalheDoPromotor, detalheDaLoja, salvarPromotor, salvarVisita, opcoes, listaDeLojas, nomesDosPromotores };
