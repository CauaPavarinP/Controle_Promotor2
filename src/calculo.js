// Regras de cálculo do sistema. Este arquivo não acessa o banco: recebe listas e devolve os números.
// Assim dá para testar as contas sem precisar de banco de dados.
//
// A peça central é a "linha de atendimento": um promotor, numa loja, num mês. Cada linha tem o seu custo
// e a sua parte do faturamento. Qualquer total (por promotor, agência, UF, loja ou geral) é só a soma das
// linhas — por isso as somas sempre batem entre si, e um filtro (ex.: UF = SC) pega só a parte certa.

const { normalizar, cnpjValido, ufDe, ehSupervisor, acharPorNome } = require('../public/js/planilha-comum');

const CAMPOS_CUSTO = ['salario', 'periculosidade', 'ajuda_celular', 'ajuda_custo', 'almoco', 'vale_transporte', 'gratificacao', 'outros_custos'];

// Custo fixo mensal do cadastro do promotor (salário + periculosidade + ajudas + almoço + VT + gratificação + outros).
function custoFixo(promotor) {
  return CAMPOS_CUSTO.reduce((soma, campo) => soma + (Number(promotor[campo]) || 0), 0);
}

// Custo fixo que entra no cálculo: supervisor não entra no custo dos promotores (o salário dele não é
// custo de atendimento de loja).
const custoFixoQueConta = (promotor) => (ehSupervisor(promotor.cargo) ? 0 : custoFixo(promotor));

const arredondar = (valor) => (valor === null || valor === undefined ? valor : Math.round(valor * 100) / 100);

// Percentual do custo sobre o faturamento. Sem faturamento não dá para calcular (null).
function percentual(custo, faturamento) {
  return faturamento > 0 ? (custo / faturamento) * 100 : null;
}

// Lista de meses "AAAA-MM" de "de" até "ate", inclusive.
function mesesEntre(de, ate) {
  const meses = [];
  let [ano, mes] = de.split('-').map(Number);
  while (`${ano}-${String(mes).padStart(2, '0')}` <= ate && meses.length < 240) {
    meses.push(`${ano}-${String(mes).padStart(2, '0')}`);
    mes++;
    if (mes > 12) { mes = 1; ano++; }
  }
  return meses;
}

// Agência de um promotor: a da planilha de atendimentos; para quem só está no cadastro, a empresa.
const agenciaDe = (promotor) => promotor.agencia || promotor.empresa || 'Sem agência';

// ---------- Filtros ----------
// Filtros "de loja" dizem ONDE foi o atendimento. Com eles, o custo de quem não tem loja lançada não entra
// (não dá para saber em que UF ou cidade ele estaria).
const FILTROS_DE_LOJA = ['uf', 'supervisor', 'municipio', 'mercado'];
const FILTROS_DE_PROMOTOR = ['agencia', 'tipo'];

function limparFiltros(filtros = {}) {
  const limpo = {};
  for (const campo of [...FILTROS_DE_PROMOTOR, ...FILTROS_DE_LOJA]) {
    const valor = String(filtros[campo] ?? '').trim().slice(0, 150);
    if (valor) limpo[campo] = valor;
  }
  return limpo;
}

const temFiltroDeLoja = (filtros) => FILTROS_DE_LOJA.some((campo) => filtros[campo]);
const temAlgumFiltro = (filtros) => Object.keys(filtros).length > 0;

// UF do filtro: sigla, nome por extenso ou "-" (lojas sem UF informada).
const ufAlvo = (uf) => (uf === '-' ? '' : ufDe(uf) || uf);

function promotorPassa(linha, filtros) {
  if (filtros.agencia && normalizar(linha.agencia) !== normalizar(filtros.agencia)) return false;
  if (filtros.tipo && linha.tipo !== filtros.tipo) return false;
  return true;
}

function linhaPassa(linha, filtros) {
  if (!promotorPassa(linha, filtros)) return false;
  if (filtros.uf && linha.uf !== ufAlvo(filtros.uf)) return false;
  if (filtros.supervisor && normalizar(linha.supervisor) !== normalizar(filtros.supervisor)) return false;
  if (filtros.municipio && normalizar(linha.cidade) !== normalizar(filtros.municipio)) return false;
  if (filtros.mercado && !normalizar(linha.lojaNome).includes(normalizar(filtros.mercado))) return false;
  return true;
}

// ---------- Custo de cada atendimento ----------
// 1) Valor do mês informado na planilha de atendimentos: vale esse valor.
// 2) Sem valor, mas o promotor tem custo fixo no cadastro (CLT) e NENHUMA loja dele no mês tem valor:
//    o custo fixo é dividido entre as lojas dele no mês (pelas visitas; sem visitas, em partes iguais).
// 3) Senão: custo NÃO INFORMADO (null). Não vira zero, para não parecer que a loja está dentro da meta.
function custosDosAtendimentos(visitas, promotoresPorId) {
  const grupos = new Map(); // um grupo por promotor + mês
  for (const visita of visitas) {
    const chave = `${visita.promotor_id}|${visita.mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(visita);
  }
  const custos = new Map(); // id da visita -> { custo, origem }
  for (const grupo of grupos.values()) {
    const algumInformado = grupo.some((v) => v.custo !== null && v.custo !== undefined);
    const fixo = custoFixoQueConta(promotoresPorId.get(grupo[0].promotor_id) || {});
    const totalVisitas = grupo.reduce((soma, v) => soma + (v.qtd_visitas || 0), 0);
    for (const v of grupo) {
      if (v.custo !== null && v.custo !== undefined) custos.set(v.id, { custo: Number(v.custo), origem: 'planilha' });
      else if (!algumInformado && fixo > 0) {
        const parte = totalVisitas > 0 ? (v.qtd_visitas || 0) / totalVisitas : 1 / grupo.length;
        custos.set(v.id, { custo: fixo * parte, origem: 'cadastro' });
      } else custos.set(v.id, { custo: null, origem: null });
    }
  }
  return custos;
}

// ---------- Análise do período ----------
// Recebe tudo o que o banco tem do período e devolve as linhas de atendimento (já filtradas),
// o faturamento que ficou sem loja atendida e o custo de quem não tem loja lançada.
//
//  promotores:   cadastro completo
//  lojas:        lojas que aparecem nas visitas
//  visitas:      atendimentos do período (SEM filtro: a divisão do faturamento precisa enxergar todas as lojas)
//  faturamentos: [{ cnpj, mes, valor }] do ERP no período (já somando as empresas escolhidas)
//  clientes:     [{ cnpj, nome, cidade, uf }] do ERP
//  mesesComErp:  meses do período que têm faturamento importado (de qualquer empresa)
//  supervisores:  cadastro de supervisores (ligam-se aos atendimentos pela coluna "Supervisor" da planilha)
function analisar({ promotores, lojas, visitas, faturamentos, clientes = [], supervisores = [], mesesComErp, de, ate, filtros = {}, meta }) {
  filtros = limparFiltros(filtros);
  const meses = mesesEntre(de, ate);
  const erp = new Set(mesesComErp);
  const promotoresPorId = new Map(promotores.map((p) => [p.id, p]));
  const lojasPorId = new Map(lojas.map((l) => [l.id, l]));
  const clientesPorCnpj = new Map(clientes.map((c) => [c.cnpj, c]));
  const custos = custosDosAtendimentos(visitas, promotoresPorId);
  // Supervisor de cada nome escrito na planilha (nome completo ou primeiro nome único; sem acento).
  const supervisorDoNome = new Map();
  const supervisorDe = (nome) => {
    const chave = normalizar(nome);
    if (!supervisorDoNome.has(chave)) supervisorDoNome.set(chave, chave ? acharPorNome(nome, supervisores) : null);
    return supervisorDoNome.get(chave);
  };
  const mesesComAtendimento = new Set(visitas.map((v) => v.mes));

  // CNPJ válido de cada loja (CNPJ errado ou vazio = loja sem CNPJ, faturamento zero).
  const cnpjDaLoja = (loja) => (loja && cnpjValido(String(loja.cnpj || '')) ? loja.cnpj : '');

  // Quantas lojas usam o mesmo CNPJ em cada mês, e quantos promotores atendem cada loja em cada mês.
  const lojasPorCnpjMes = new Map();
  const promotoresPorLojaMes = new Map();
  const adicionar = (mapa, chave, item) => { if (!mapa.has(chave)) mapa.set(chave, new Set()); mapa.get(chave).add(item); };
  for (const v of visitas) {
    const cnpj = cnpjDaLoja(lojasPorId.get(v.loja_id));
    if (cnpj) adicionar(lojasPorCnpjMes, `${cnpj}|${v.mes}`, v.loja_id);
    adicionar(promotoresPorLojaMes, `${v.loja_id}|${v.mes}`, v.promotor_id);
  }

  const fatCnpjMes = new Map();
  let faturamentoErp = 0;
  for (const f of faturamentos) {
    const chave = `${f.cnpj}|${f.mes}`;
    fatCnpjMes.set(chave, (fatCnpjMes.get(chave) || 0) + Number(f.valor));
    faturamentoErp += Number(f.valor);
  }

  // Monta as linhas. O faturamento do CNPJ no mês é dividido igualmente entre as lojas que usam o CNPJ
  // naquele mês e, dentro da loja, entre os promotores dela. Assim a mesma compra nunca conta duas vezes.
  const todas = visitas.map((v) => {
    const promotor = promotoresPorId.get(v.promotor_id) || { id: v.promotor_id, nome: '?', tipo: '', agencia: '' };
    const loja = lojasPorId.get(v.loja_id) || { id: v.loja_id, nome: '?', cidade: '', uf: '' };
    const cnpj = cnpjDaLoja(loja);
    const lojasDoCnpj = cnpj ? lojasPorCnpjMes.get(`${cnpj}|${v.mes}`).size : 1;
    const promotoresNaLoja = promotoresPorLojaMes.get(`${v.loja_id}|${v.mes}`).size;
    let faturamento = null; // null = mês sem faturamento do ERP importado ("—" na tela)
    if (erp.has(v.mes)) faturamento = cnpj ? (fatCnpjMes.get(`${cnpj}|${v.mes}`) || 0) / lojasDoCnpj / promotoresNaLoja : 0;
    const { custo, origem } = custos.get(v.id);
    return {
      id: v.id, promotorId: promotor.id, lojaId: loja.id, mes: v.mes,
      visitas: v.qtd_visitas || 0,
      valorInformado: v.custo === null || v.custo === undefined ? null : Number(v.custo),
      custo, origemCusto: origem, faturamento,
      cnpj, temCnpj: Boolean(cnpj), lojasDoCnpj, promotoresNaLoja,
      dias: v.dias_visita || '', supervisor: v.supervisor || '', status: v.status || '',
      supervisorId: v.supervisor ? (supervisorDe(v.supervisor) || {}).id || null : null,
      promotorNome: promotor.nome, tipo: promotor.tipo, agencia: agenciaDe(promotor),
      codigo: promotor.codigo || '', cadastrado: Boolean(promotor.cadastrado), cargo: promotor.cargo || '', pendente: promotor.pendente || '',
      lojaNome: loja.nome, cidade: loja.cidade || '', uf: ufDe(loja.uf) || loja.uf || '',
    };
  });
  const linhas = todas.filter((l) => linhaPassa(l, filtros));

  // Faturamento do ERP sem loja atendida no mês (o CNPJ comprou, mas ninguém atendeu naquele mês).
  // Com filtro de agência, tipo, supervisor ou mercado ele não entra: não pertence a ninguém.
  // Com filtro de UF ou município, vale a UF/cidade do cliente no ERP.
  const cnpjsAtendidos = new Set(todas.filter((l) => l.cnpj).map((l) => l.cnpj));
  const naoAlocado = [];
  const aceitaNaoAlocado = !filtros.agencia && !filtros.tipo && !filtros.supervisor && !filtros.mercado;
  for (const [chave, valor] of fatCnpjMes) {
    if (lojasPorCnpjMes.has(chave)) continue;
    const [cnpj, mes] = chave.split('|');
    const cliente = clientesPorCnpj.get(cnpj) || { cnpj, nome: `CNPJ ${cnpj}`, cidade: '', uf: '' };
    if (!aceitaNaoAlocado) continue;
    if (filtros.uf && (ufDe(cliente.uf) || cliente.uf) !== ufAlvo(filtros.uf)) continue;
    if (filtros.municipio && normalizar(cliente.cidade) !== normalizar(filtros.municipio)) continue;
    naoAlocado.push({ cnpj, mes, valor, cliente, atendidoNoPeriodo: cnpjsAtendidos.has(cnpj) });
  }

  // Custo de quem tem salário no cadastro e NENHUMA loja lançada num mês que já tem atendimentos importados.
  // O salário foi pago, então entra no custo total; mas não no %, porque não há faturamento para comparar.
  const semLoja = [];
  if (!temFiltroDeLoja(filtros)) {
    const atendeuNoMes = new Set(visitas.map((v) => `${v.promotor_id}|${v.mes}`));
    for (const promotor of promotores) {
      const fixo = custoFixoQueConta(promotor); // supervisor fica fora (custo zero aqui)
      if (promotor.ativo === false || fixo <= 0) continue;
      if (!promotorPassa({ agencia: agenciaDe(promotor), tipo: promotor.tipo }, filtros)) continue;
      for (const mes of meses) {
        if (!mesesComAtendimento.has(mes) || atendeuNoMes.has(`${promotor.id}|${mes}`)) continue;
        if (promotor.admissao && promotor.admissao.slice(0, 7) > mes) continue; // ainda não tinha sido admitido
        semLoja.push({ promotorId: promotor.id, promotorNome: promotor.nome, agencia: agenciaDe(promotor), tipo: promotor.tipo, mes, custo: fixo });
      }
    }
  }

  return {
    meta, meses, filtros, linhas, todas, naoAlocado, semLoja,
    mesesComErp: meses.filter((m) => erp.has(m)),
    mesesComAtendimento: meses.filter((m) => mesesComAtendimento.has(m)),
    faturamentoErp: arredondar(faturamentoErp),
    clientesPorCnpj,
  };
}

// ---------- Somas ----------
// Soma um grupo de linhas e diz a situação do grupo.
//  - custo: soma dos custos conhecidos (planilha ou cadastro). "custoNaoInformado" conta as linhas sem custo.
//  - faturamento: soma das partes conhecidas; null se TODOS os meses do grupo estão sem faturamento do ERP.
//  - percentual: só com as linhas que têm custo E faturamento do mês importado (as comparáveis).
function somar(linhas, meta, custoExtra = 0) {
  let custo = 0; let faturamento = null; let visitas = 0;
  let custoComparavel = 0; let fatComparavel = 0;
  let comCusto = 0; let comparaveis = 0; let comparaveisSemCnpj = 0; let comCustoSemErp = 0;
  for (const l of linhas) {
    visitas += l.visitas;
    if (l.faturamento !== null) faturamento = (faturamento || 0) + l.faturamento;
    if (l.custo === null) continue;
    comCusto++;
    custo += l.custo;
    if (l.faturamento === null) { comCustoSemErp++; continue; }
    comparaveis++;
    if (!l.temCnpj) comparaveisSemCnpj++;
    custoComparavel += l.custo;
    fatComparavel += l.faturamento;
  }
  const pct = percentual(custoComparavel, fatComparavel);
  let situacao;
  if (!linhas.length) situacao = custoExtra > 0 ? 'sem_lojas' : 'sem_dados';
  else if (!comCusto) situacao = 'custo_nao_informado';
  else if (!comparaveis) situacao = 'falta_faturamento';
  else if (pct !== null) situacao = pct <= meta ? 'dentro' : 'fora';
  else if (comparaveisSemCnpj === comparaveis) situacao = 'sem_cnpj';
  else situacao = custoComparavel > 0 ? 'sem_faturamento' : 'sem_dados';
  // Sem nenhum custo conhecido, o custo é "não informado" (null), e não zero.
  const conhecido = comCusto > 0 || custoExtra > 0;
  return {
    custo: conhecido ? arredondar(custo + custoExtra) : null,
    custoDasLojas: comCusto ? arredondar(custo) : null,
    custoSemLoja: arredondar(custoExtra),
    faturamento: arredondar(faturamento),
    visitas,
    percentual: pct,
    situacao,
    custoComparavel: arredondar(custoComparavel),
    faturamentoComparavel: arredondar(fatComparavel),
    linhasSemCusto: linhas.length - comCusto,
    linhasSemErp: comCustoSemErp,
  };
}

// Agrupa linhas por uma chave (ex.: id do promotor). Devolve Map(chave -> linhas).
function agrupar(linhas, chaveDe) {
  const grupos = new Map();
  for (const l of linhas) {
    const chave = chaveDe(l);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }
  return grupos;
}

// ---------- Avisos de qualidade dos dados ----------
const reais = (valor) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);
const NOMES_MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (mes) => `${NOMES_MESES[Number(mes.slice(5)) - 1]}/${mes.slice(0, 4)}`;
const cnpjFormatado = (c) => (c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c);
const LIMITE_ITENS = 15;
const aviso = (id, titulo, texto, itens = []) => ({ id, titulo, texto, itens: itens.slice(0, LIMITE_ITENS), mais: Math.max(0, itens.length - LIMITE_ITENS) });

function avisosDe(analise) {
  const { linhas, naoAlocado, semLoja, meses } = analise;
  const avisos = [];
  const mesesComLinhas = new Set(linhas.map((l) => l.mes));

  const semErp = meses.filter((m) => mesesComLinhas.has(m) && !analise.mesesComErp.includes(m));
  if (semErp.length) {
    avisos.push(aviso('meses_sem_erp', 'Falta o faturamento do ERP',
      `Há atendimentos em ${semErp.map(rotuloMes).join(', ')}, mas o faturamento ${semErp.length > 1 ? 'desses meses' : 'desse mês'} não foi importado. Nesses meses o faturamento aparece como "—" e fica fora do %.`));
  }

  const semAtendimento = meses.filter((m) => !analise.mesesComAtendimento.includes(m));
  if (semAtendimento.length) {
    avisos.push(aviso('meses_sem_atendimento', 'Meses sem arquivo de atendimento',
      `Nenhum arquivo de atendimento foi importado em ${semAtendimento.map(rotuloMes).join(', ')}. O custo desses meses é zero e o faturamento deles não entra no %.`));
  }

  // Lojas atendidas (nas linhas filtradas) cujo CNPJ comprou em meses sem atendimento.
  const cnpjsDasLinhas = new Map();
  for (const l of linhas) if (l.cnpj && !cnpjsDasLinhas.has(l.cnpj)) cnpjsDasLinhas.set(l.cnpj, l.lojaNome);
  const foraDoPct = agrupar(naoAlocado.filter((n) => cnpjsDasLinhas.has(n.cnpj)), (n) => n.cnpj);
  if (foraDoPct.size) {
    let total = 0;
    const itens = [...foraDoPct].map(([cnpj, lista]) => {
      const valor = lista.reduce((s, n) => s + n.valor, 0);
      total += valor;
      return { valor, texto: `${cnpjsDasLinhas.get(cnpj)} (${cnpjFormatado(cnpj)}): ${reais(valor)} em ${lista.map((n) => rotuloMes(n.mes)).sort().join(', ')}` };
    }).sort((a, b) => b.valor - a.valor);
    avisos.push(aviso('compras_sem_atendimento', 'Compras em meses sem atendimento',
      `${itens.length} loja(s) atendida(s) compraram em meses em que não tiveram atendimento lançado. ${reais(total)} ficaram fora do %.`,
      itens.map((i) => i.texto)));
  }

  // Lojas sem o valor do mês na planilha.
  const paresSemValor = agrupar(linhas.filter((l) => l.valorInformado === null), (l) => `${l.promotorId}|${l.lojaId}`);
  if (paresSemValor.size) {
    const naoInformado = [...paresSemValor.values()].filter((ls) => ls.some((l) => l.custo === null));
    const estimados = paresSemValor.size - naoInformado.length;
    const partes = [];
    if (estimados) partes.push(`${estimados} usam o salário do cadastro do promotor (custo estimado)`);
    if (naoInformado.length) partes.push(`${naoInformado.length} ficaram com a situação "custo não informado" e não entram no %`);
    avisos.push(aviso('custo_nao_informado', 'Lojas sem o valor do mês',
      `${paresSemValor.size} atendimento(s) de loja sem o valor do mês na planilha (ex.: CLT): ${partes.join(' e ')}.`,
      naoInformado.map((ls) => `${ls[0].agencia} — ${ls[0].lojaNome}${ls[0].cidade ? ` (${ls[0].cidade})` : ''}`)));
  }

  const semCnpj = agrupar(linhas.filter((l) => !l.temCnpj), (l) => l.lojaId);
  if (semCnpj.size) {
    avisos.push(aviso('sem_cnpj', 'Lojas sem CNPJ válido',
      `${semCnpj.size} loja(s) atendida(s) estão sem CNPJ válido. Sem o CNPJ não dá para ligar com o faturamento do ERP, então elas ficam com faturamento zero (e o custo delas pesa no %).`,
      [...semCnpj.values()].map((ls) => `${ls[0].lojaNome}${ls[0].cidade ? ` (${ls[0].cidade})` : ''}`)));
  }

  const divididos = agrupar(linhas.filter((l) => l.lojasDoCnpj > 1), (l) => l.cnpj);
  if (divididos.size) {
    avisos.push(aviso('cnpj_dividido', 'CNPJ dividido entre lojas',
      `${divididos.size} CNPJ(s) aparecem em mais de uma loja no mesmo mês (rede que compra pela matriz ou pelo CD). O faturamento de cada um foi dividido em partes iguais entre essas lojas.`,
      [...divididos].map(([cnpj, ls]) => `${cnpjFormatado(cnpj)}: ${[...new Set(ls.map((l) => l.lojaNome))].join(', ')}`)));
  }

  // Atendimentos com código de promotor que não acharam ninguém no cadastro: o código ou o primeiro nome
  // não bate com a planilha de cadastro. Sem cadastro, não há salário para calcular o custo (CLT).
  const semCadastro = agrupar(linhas.filter((l) => l.codigo && !l.cadastrado), (l) => l.promotorId);
  if (semCadastro.size) {
    avisos.push(aviso('codigo_sem_cadastro', 'Código de promotor sem cadastro',
      `${semCadastro.size} promotor(es) dos atendimentos têm código, mas não foram encontrados no cadastro de promotores (o código ou o primeiro nome não bate). Sem cadastro não há salário: o custo deles fica "não informado" quando a planilha não traz o valor.`,
      [...semCadastro.values()].map((ls) => `${ls[0].agencia} — ${ls[0].promotorNome} (código ${ls[0].codigo}): ${new Set(ls.map((l) => l.lojaId)).size} loja(s)`)));
  }

  // Promotores que a importação não conseguiu identificar com certeza (ligar à mão na tela Promotores).
  const pendentes = agrupar(linhas.filter((l) => l.pendente), (l) => l.promotorId);
  if (pendentes.size) {
    const motivo = { ambiguo: 'mais de um parecido no cadastro', nao_encontrado: 'CLT que não está no cadastro' };
    avisos.push(aviso('promotores_nao_identificados', 'Promotores não identificados',
      `${pendentes.size} promotor(es) da planilha de atendimentos não foram identificados com certeza no cadastro. Ligue cada um ao promotor certo na tela Promotores: a ligação fica guardada para as próximas importações.`,
      [...pendentes.values()].map((ls) => `${ls[0].agencia} — ${ls[0].promotorNome} (${motivo[ls[0].pendente] || ls[0].pendente}): ${new Set(ls.map((l) => l.lojaId)).size} loja(s)`)));
  }

  // Nome da coluna "Supervisor" da planilha que não achou ninguém no cadastro de supervisores.
  const supervisorSemCadastro = agrupar(linhas.filter((l) => l.supervisor && !l.supervisorId), (l) => normalizar(l.supervisor));
  if (supervisorSemCadastro.size) {
    avisos.push(aviso('supervisor_sem_cadastro', 'Supervisor sem cadastro',
      `${supervisorSemCadastro.size} nome(s) da coluna "Supervisor" da planilha de atendimentos não foram encontrados no cadastro de supervisores (nem pelo nome completo, nem por um primeiro nome único). Cadastre-os na tela Supervisores.`,
      [...supervisorSemCadastro.values()].map((ls) => `${ls[0].supervisor}: ${new Set(ls.map((l) => l.lojaId)).size} loja(s)`)));
  }

  if (semLoja.length) {
    const porPromotor = agrupar(semLoja, (s) => s.promotorId);
    const total = semLoja.reduce((s, x) => s + x.custo, 0);
    avisos.push(aviso('sem_lojas', 'Promotores sem loja lançada',
      `${porPromotor.size} promotor(es) com salário no cadastro não têm nenhuma loja no arquivo de atendimentos. ${reais(total)} entram no custo total, mas não no %.`,
      [...porPromotor.values()].map((ls) => `${ls[0].promotorNome} (${ls[0].agencia})`)));
  }
  return avisos;
}

module.exports = {
  CAMPOS_CUSTO, FILTROS_DE_LOJA, custoFixo, custoFixoQueConta, percentual, arredondar, mesesEntre, agenciaDe,
  limparFiltros, temFiltroDeLoja, temAlgumFiltro, linhaPassa, promotorPassa, analisar, somar, agrupar, avisosDe,
};
