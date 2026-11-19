// Monta cada tela a partir do motor de cálculo (src/calculo.js): busca no banco tudo o que o período tem,
// passa pelo "analisar" e agrupa as linhas de atendimento do jeito que a tela precisa.
const config = require('./config');
const { consulta, transacao } = require('./db');
const { ligarPendentesDe } = require('./ligacaoPromotor');
const { problemaNaData } = require('./datas');
const calc = require('./calculo');
const { mesValido, normalizar, cnpjValido, ufDe, ehSupervisor } = require('./planilha');
const { ErroDeValidacao } = require('./auth');

const { CAMPOS_CUSTO, custoFixo, agenciaDe, somar, agrupar } = calc;
const meta = () => config.meta;

function lerPeriodo(query) {
  const { de, ate } = query;
  if (!mesValido(de) || !mesValido(ate)) throw new ErroDeValidacao('Informe o período (mês inicial e final).');
  if (de > ate) throw new ErroDeValidacao('O mês inicial não pode ser depois do mês final.');
  return { de, ate };
}

const texto = (v) => String(v ?? '').trim();
const contem = (valor, busca) => normalizar(valor).includes(busca);

// Busca no banco tudo o que o período tem e devolve a análise (ver calculo.analisar).
async function carregar({ de, ate }, filtros = {}, empresa = '') {
  const [promotores, visitas, faturamentos, mesesErp, clientes, supervisores, vinculos] = await Promise.all([
    consulta('SELECT * FROM promotores'),
    consulta('SELECT id, promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita, supervisor, status FROM visitas WHERE mes BETWEEN $1 AND $2', [de, ate]),
    consulta("SELECT cnpj, mes, sum(valor) AS valor FROM faturamento_erp WHERE mes BETWEEN $1 AND $2 AND ($3 = '' OR empresa = $3) GROUP BY cnpj, mes", [de, ate, texto(empresa)]),
    consulta('SELECT DISTINCT mes FROM faturamento_erp WHERE mes BETWEEN $1 AND $2', [de, ate]),
    consulta('SELECT c.cnpj, c.nome, c.cidade, c.uf FROM clientes_erp c WHERE EXISTS (SELECT 1 FROM faturamento_erp f WHERE f.cnpj = c.cnpj AND f.mes BETWEEN $1 AND $2)', [de, ate]),
    consulta('SELECT id, nome, chave, codigo, cargo, empresa FROM supervisores ORDER BY nome'),
    consulta('SELECT vs.visita_id, vs.supervisor_id FROM visita_supervisor vs JOIN visitas v ON v.id = vs.visita_id WHERE v.mes BETWEEN $1 AND $2', [de, ate]),
  ]);
  const lojas = await consulta('SELECT id, nome, cnpj, cidade, uf FROM lojas WHERE id = ANY($1::int[])', [[...new Set(visitas.map((v) => v.loja_id))]]);
  const analise = calc.analisar({
    promotores, lojas, visitas, faturamentos, clientes, supervisores, vinculos, mesesComErp: mesesErp.map((m) => m.mes), de, ate, filtros, meta: meta(),
  });
  return { ...analise, supervisores, cadastro: promotores, lojasPorId: new Map(lojas.map((l) => [l.id, l])) };
}

const soma = (lista, campo) => lista.reduce((total, item) => total + (item[campo] || 0), 0);
const arred = calc.arredondar;

// Somas de um promotor: as linhas dele + o custo de meses sem loja lançada.
function somarPromotor(linhas, semLoja) {
  return somar(linhas || [], meta(), soma(semLoja || [], 'custo'));
}

// ---------- Resumo ----------
async function resumo(query) {
  const a = await carregar(lerPeriodo(query), query, query.empresa);
  const custoSemLoja = soma(a.semLoja, 'custo');
  const total = somar(a.linhas, meta(), custoSemLoja);
  const naoAlocado = soma(a.naoAlocado, 'valor');
  const porPromotor = agrupar(a.linhas, (l) => l.promotorId);
  const semLojaPor = agrupar(a.semLoja, (s) => s.promotorId);
  const situacoes = [...new Set([...porPromotor.keys(), ...semLojaPor.keys()])]
    .map((id) => somarPromotor(porPromotor.get(id), semLojaPor.get(id)).situacao);
  const contar = (s) => situacoes.filter((x) => x === s).length;
  return {
    meta: meta(),
    filtrado: calc.temAlgumFiltro(a.filtros),
    // Faturamento total = parte das lojas atendidas + o que o ERP faturou sem atendimento no mês.
    // Sem filtro, é exatamente o total do ERP no período. Sem nenhum mês do ERP importado: "—".
    faturamentoTotal: a.mesesComErp.length ? arred((total.faturamento || 0) + naoAlocado) : null,
    faturamentoAtendido: total.faturamento,
    faturamentoSemAtendimento: arred(naoAlocado),
    custoTotal: total.custo,
    custoComLojas: total.custoDasLojas,
    custoSemLojas: arred(custoSemLoja),
    custoComparavel: total.custoComparavel,
    faturamentoComparavel: total.faturamentoComparavel,
    percentual: total.percentual,
    situacao: total.situacao,
    promotores: situacoes.length,
    dentro: contar('dentro'),
    fora: contar('fora') + contar('sem_faturamento'),
    semLojas: contar('sem_lojas'),
    custoNaoInformado: contar('custo_nao_informado'),
    faltaFaturamento: contar('falta_faturamento') + contar('sem_cnpj'),
    avisos: calc.avisosDe(a),
  };
}

// ---------- Faturamento das lojas ----------
// Uma linha por loja atendida (com a parte dela do faturamento) e uma por CNPJ do ERP que comprou sem
// atendimento no mês. A soma das linhas, sem filtro, é o faturamento total do ERP no período.
function linhasDeFaturamento(a) {
  const lojas = [...agrupar(a.linhas, (l) => l.lojaId)].map(([id, ls]) => {
    const s = somar(ls, meta());
    const l = ls[0];
    return {
      tipo: 'loja', id, nome: l.lojaNome, cnpj: l.cnpj, cidade: l.cidade, uf: l.uf,
      faturamento: s.faturamento, custo: s.custo, visitas: s.visitas, percentual: s.percentual, situacao: s.situacao,
      qtdPromotores: new Set(ls.map((x) => x.promotorId)).size,
      lojasDoCnpj: Math.max(...ls.map((x) => x.lojasDoCnpj)),
      linhas: ls,
    };
  });
  const clientes = [...agrupar(a.naoAlocado, (n) => n.cnpj)].map(([cnpj, ns]) => ({
    tipo: 'cliente', id: null, nome: ns[0].cliente.nome, cnpj, cidade: ns[0].cliente.cidade, uf: ufDe(ns[0].cliente.uf) || ns[0].cliente.uf,
    faturamento: arred(soma(ns, 'valor')), custo: null, visitas: 0, percentual: null,
    situacao: ns[0].atendidoNoPeriodo ? 'sem_atendimento_no_mes' : 'sem_promotor',
    qtdPromotores: 0, lojasDoCnpj: 0, linhas: [],
  }));
  return [...lojas, ...clientes];
}

async function faturamentoPorLoja(query) {
  const a = await carregar(lerPeriodo(query), query, query.empresa);
  const busca = normalizar(query.busca);
  const digitos = texto(query.busca).replace(/\D/g, '');
  const linhas = linhasDeFaturamento(a)
    .filter((l) => !busca || contem(l.nome, busca) || contem(l.cidade, busca) || (digitos.length >= 3 && l.cnpj.includes(digitos)))
    .filter((l) => !query.situacao || l.situacao === query.situacao)
    .sort((x, y) => (y.faturamento ?? -1) - (x.faturamento ?? -1) || x.nome.localeCompare(y.nome));
  // Totais das linhas mostradas: o % vem das linhas de atendimento delas.
  const t = somar(linhas.flatMap((l) => l.linhas), meta());
  const fatClientes = soma(linhas.filter((l) => l.tipo === 'cliente'), 'faturamento');
  const temFaturamento = linhas.some((l) => l.faturamento !== null);
  return {
    meta: meta(),
    lojas: linhas.map(({ linhas: _, ...resto }) => resto),
    totais: {
      faturamento: temFaturamento ? arred((t.faturamento || 0) + fatClientes) : null,
      custo: t.custo, visitas: t.visitas, percentual: t.percentual,
    },
    avisos: calc.avisosDe(a),
  };
}

// ---------- Promotores ----------
async function listaDePromotores(query) {
  const a = await carregar(lerPeriodo(query), query, query.empresa);
  const porPromotor = agrupar(a.linhas, (l) => l.promotorId);
  const semLojaPor = agrupar(a.semLoja, (s) => s.promotorId);
  const comFiltroDeLoja = calc.temFiltroDeLoja(a.filtros);
  const busca = normalizar(query.busca);
  const lista = a.cadastro
    .filter((p) => !ehSupervisor(p.cargo)) // supervisor não é promotor (ver tela Supervisores)
    .filter((p) => calc.promotorPassa({ agencia: agenciaDe(p), tipo: p.tipo }, a.filtros))
    // Com filtro de UF, cidade, supervisor ou mercado, só aparece quem atendeu ali.
    .filter((p) => !comFiltroDeLoja || porPromotor.has(p.id))
    .map((p) => {
      const ls = porPromotor.get(p.id) || [];
      const s = somarPromotor(ls, semLojaPor.get(p.id));
      return {
        id: p.id, nome: p.nome, tipo: p.tipo, agencia: agenciaDe(p), empresa: p.empresa, codigo: p.codigo, ativo: p.ativo,
        cargo: p.cargo, cadastrado: p.cadastrado, pendente: p.pendente,
        qtdLojas: new Set(ls.map((l) => l.lojaId)).size,
        visitas: s.visitas, custo: s.custo, custoSemLoja: s.custoSemLoja, faturamento: s.faturamento,
        percentual: s.percentual, situacao: s.situacao,
      };
    })
    .filter((p) => !busca || contem(p.nome, busca) || contem(p.agencia, busca) || contem(p.empresa, busca) || p.codigo === texto(query.busca))
    .filter((p) => !query.situacao || p.situacao === query.situacao)
    .filter((p) => !query.ativo || String(p.ativo) === query.ativo)
    // Primeiro quem mais estoura a meta; quem não tem percentual vai para o fim.
    .sort((x, y) => (y.percentual ?? -1) - (x.percentual ?? -1) || (y.custo ?? -1) - (x.custo ?? -1) || x.nome.localeCompare(y.nome));
  return { meta: meta(), promotores: lista, avisos: calc.avisosDe(a) };
}

function resumoDaLoja(ls) {
  const s = somar(ls, meta());
  const l = ls[0];
  return {
    loja: { id: l.lojaId, nome: l.lojaNome, cnpj: l.cnpj, cidade: l.cidade, uf: l.uf },
    visitas: s.visitas, custo: s.custo, faturamento: s.faturamento, percentual: s.percentual, situacao: s.situacao,
    dias: ls.find((x) => x.dias)?.dias || '',
    lojasDoCnpj: Math.max(...ls.map((x) => x.lojasDoCnpj)),
  };
}

// Ficha do promotor: só o período (os filtros de agência, UF etc. não se aplicam aqui).
async function detalheDoPromotor(id, query) {
  const a = await carregar(lerPeriodo(query));
  const promotor = a.cadastro.find((p) => p.id === id);
  if (!promotor) return null;
  const ls = a.linhas.filter((l) => l.promotorId === id);
  const s = somarPromotor(ls, a.semLoja.filter((x) => x.promotorId === id));
  return {
    meta: meta(),
    promotor: { ...promotor, custoFixo: custoFixo(promotor), supervisor: ehSupervisor(promotor.cargo) },
    visitas: s.visitas, custo: s.custo, faturamento: s.faturamento, custoSemLoja: s.custoSemLoja,
    percentual: s.percentual, situacao: s.situacao,
    supervisores: [...new Set(ls.flatMap((l) => l.supervisorNomes))].sort(),
    lojas: [...agrupar(ls, (l) => l.lojaId).values()].map((g) => ({
      ...resumoDaLoja(g),
      atendimentos: g.map((l) => ({
        id: l.id, mes: l.mes, visitas: l.visitas, custo: arred(l.custo), origemCusto: l.origemCusto,
        valorInformado: l.valorInformado, faturamento: arred(l.faturamento), promotoresNaLoja: l.promotoresNaLoja, lojasDoCnpj: l.lojasDoCnpj,
      })),
    })).sort((x, y) => (y.custo ?? -1) - (x.custo ?? -1)),
  };
}

// Faturamento do ERP de um CNPJ, mês a mês e por empresa.
async function faturamentoDoCnpj(cnpj, { de, ate }) {
  const linhas = await consulta('SELECT mes, empresa, valor FROM faturamento_erp WHERE cnpj = $1 AND mes BETWEEN $2 AND $3 ORDER BY mes, empresa', [cnpj, de, ate]);
  const porMes = new Map();
  for (const f of linhas) {
    if (!porMes.has(f.mes)) porMes.set(f.mes, { total: 0, empresas: [] });
    porMes.get(f.mes).total += f.valor;
    porMes.get(f.mes).empresas.push({ empresa: f.empresa, valor: f.valor });
  }
  return porMes;
}

// Ficha da loja atendida: a parte dela do faturamento (o CNPJ pode ser dividido com outras lojas),
// o custo e os promotores, mês a mês.
async function detalheDaLoja(id, query) {
  const periodo = lerPeriodo(query);
  const a = await carregar(periodo);
  const [loja] = await consulta('SELECT id, nome, cnpj, cidade, uf, endereco FROM lojas WHERE id = $1', [id]);
  if (!loja) return null;
  const ls = a.linhas.filter((l) => l.lojaId === id);
  const s = somar(ls, meta());
  const cnpj = cnpjValido(String(loja.cnpj || '')) ? loja.cnpj : '';
  const fatCnpj = cnpj ? await faturamentoDoCnpj(cnpj, periodo) : new Map();
  const porMesLinhas = agrupar(ls, (l) => l.mes);
  const mesesComErp = new Set(a.mesesComErp);
  const meses = a.meses.filter((m) => porMesLinhas.has(m) || fatCnpj.has(m)).reverse();
  const porMes = meses.map((mes) => {
    const doMes = porMesLinhas.get(mes) || [];
    const cnpjNoMes = fatCnpj.get(mes);
    const base = {
      mes,
      faturamentoCnpj: mesesComErp.has(mes) ? arred(cnpjNoMes ? cnpjNoMes.total : 0) : null,
      empresas: cnpjNoMes ? cnpjNoMes.empresas : [],
      lojasDoCnpj: doMes.length ? doMes[0].lojasDoCnpj : 0,
    };
    if (!doMes.length) {
      return { ...base, faturamento: null, custo: null, percentual: null, situacao: 'sem_atendimento_no_mes' };
    }
    const sm = somar(doMes, meta());
    return { ...base, faturamento: sm.faturamento, custo: sm.custo, percentual: sm.percentual, situacao: sm.situacao };
  });
  // Outras lojas que usaram o mesmo CNPJ no período (rede que compra pela matriz ou pelo CD).
  const outras = cnpj ? [...agrupar(a.todas.filter((l) => l.cnpj === cnpj && l.lojaId !== id), (l) => l.lojaId).values()]
    .map((g) => ({ id: g[0].lojaId, nome: g[0].lojaNome, cidade: g[0].cidade, uf: g[0].uf })) : [];
  return {
    meta: meta(),
    loja: { ...loja, uf: ufDe(loja.uf) || loja.uf, cnpj },
    cnpjInformado: loja.cnpj || '',
    faturamento: s.faturamento, custo: s.custo, visitas: s.visitas, percentual: s.percentual,
    situacao: ls.length ? s.situacao : 'sem_dados',
    porMes,
    outrasLojasDoCnpj: outras,
    promotores: [...agrupar(ls, (l) => l.promotorId).values()].map((g) => {
      const sp = somar(g, meta());
      return {
        id: g[0].promotorId, nome: g[0].promotorNome, tipo: g[0].tipo, agencia: g[0].agencia,
        dias: g.find((x) => x.dias)?.dias || '', visitas: sp.visitas, custo: sp.custo, faturamento: sp.faturamento,
        percentual: sp.percentual, situacao: sp.situacao,
      };
    }).sort((x, y) => (y.custo ?? -1) - (x.custo ?? -1)),
  };
}

// Ficha de um cliente do ERP (CNPJ) que não é uma loja atendida, ou que comprou em meses sem atendimento.
async function detalheDoCliente(cnpj, query) {
  const periodo = lerPeriodo(query);
  const [cliente] = await consulta('SELECT cnpj, nome, cidade, uf FROM clientes_erp WHERE cnpj = $1', [cnpj]);
  if (!cliente) return null;
  const [fatCnpj, a] = await Promise.all([faturamentoDoCnpj(cnpj, periodo), carregar(periodo)]);
  const doCnpj = a.todas.filter((l) => l.cnpj === cnpj);
  const lojasPorMes = agrupar(doCnpj, (l) => l.mes);
  const porMes = [...fatCnpj].sort((x, y) => y[0].localeCompare(x[0])).map(([mes, f]) => ({
    mes, faturamento: arred(f.total), empresas: f.empresas,
    lojasAtendidas: lojasPorMes.has(mes) ? new Set(lojasPorMes.get(mes).map((l) => l.lojaId)).size : 0,
  }));
  return {
    cliente: { ...cliente, uf: ufDe(cliente.uf) || cliente.uf },
    faturamento: arred(porMes.reduce((t, m) => t + m.faturamento, 0)),
    porMes,
    lojas: [...agrupar(doCnpj, (l) => l.lojaId).values()].map((g) => ({
      id: g[0].lojaId, nome: g[0].lojaNome, cidade: g[0].cidade, uf: g[0].uf, meses: [...new Set(g.map((l) => l.mes))].sort(),
    })),
  };
}

// ---------- Lojas por UF ----------
// Uma linha por promotor + loja, com o valor informado em cada mês do período.
async function lojasPorUf(query) {
  const a = await carregar(lerPeriodo(query), query, query.empresa);
  // Botões de UF: quantas lojas cada UF tem com os OUTROS filtros (a UF escolhida não entra na conta).
  const semUf = { ...a.filtros };
  delete semUf.uf;
  const contagem = new Map();
  for (const l of a.todas.filter((x) => calc.linhaPassa(x, semUf))) {
    if (!contagem.has(l.uf)) contagem.set(l.uf, new Set());
    contagem.get(l.uf).add(l.lojaId);
  }
  const agenciasComCusto = new Set(a.linhas.filter((l) => l.custo !== null).map((l) => l.agencia));
  const linhas = [...agrupar(a.linhas, (l) => `${l.promotorId}|${l.lojaId}`).values()].map((g) => {
    const s = somar(g, meta());
    const l = g[0];
    const valores = {};
    for (const x of g) if (x.valorInformado !== null) valores[x.mes] = arred((valores[x.mes] || 0) + x.valorInformado);
    const informados = Object.values(valores);
    return {
      promotorId: l.promotorId, promotor: l.promotorNome, tipo: l.tipo, agencia: l.agencia,
      supervisor: [...new Set(g.flatMap((x) => x.supervisorNomes))].sort().join(', '),
      lojaId: l.lojaId, loja: l.lojaNome, cnpj: l.cnpj, cidade: l.cidade, uf: l.uf,
      visitas: s.visitas, valores, total: informados.length ? arred(informados.reduce((t, v) => t + v, 0)) : null,
      custo: s.custo, faturamento: s.faturamento, percentual: s.percentual, situacao: s.situacao,
      agenciaTemCusto: agenciasComCusto.has(l.agencia),
    };
  }).sort((x, y) => x.uf.localeCompare(y.uf) || x.agencia.localeCompare(y.agencia) || x.loja.localeCompare(y.loja));
  return {
    meta: meta(),
    meses: a.meses,
    ufs: [...contagem].map(([uf, lojas]) => ({ uf: uf || '', lojas: lojas.size })).sort((x, y) => x.uf.localeCompare(y.uf)),
    linhas,
    avisos: calc.avisosDe(a),
  };
}

// ---------- Supervisores ----------
// Cada supervisor e os promotores dele no período (pelos vínculos dos atendimentos), com agência e lojas.
// Mais: promotores sem supervisor no período e pessoas com cargo de supervisor que ainda estão como promotor.
async function supervisoresDoPeriodo(query) {
  const a = await carregar(lerPeriodo(query), query, query.empresa);
  const promotoresDe = (ls) => [...agrupar(ls, (l) => l.promotorId).values()].map((g) => ({
    id: g[0].promotorId, nome: g[0].promotorNome, agencia: g[0].agencia, tipo: g[0].tipo,
    lojas: new Set(g.map((l) => l.lojaId)).size,
  })).sort((x, y) => x.nome.localeCompare(y.nome));
  const mostrarTodos = !calc.temAlgumFiltro(a.filtros);
  const supervisores = a.supervisores.map((sup) => {
    const ls = a.linhas.filter((l) => l.supervisorIds.includes(sup.id));
    return {
      id: sup.id, nome: sup.nome, codigo: sup.codigo, cargo: sup.cargo, empresa: sup.empresa,
      promotores: promotoresDe(ls), agencias: [...new Set(ls.map((l) => l.agencia))].sort(), lojas: new Set(ls.map((l) => l.lojaId)).size,
    };
  }).filter((sup) => mostrarTodos || sup.promotores.length);
  // Promotor sem supervisor = nenhum atendimento dele no período tem supervisor.
  const porPromotor = agrupar(a.linhas, (l) => l.promotorId);
  const semSupervisor = promotoresDe([...porPromotor.values()].filter((ls) => ls.every((l) => !l.supervisorIds.length)).flat());
  return { supervisores, semSupervisor, avisos: calc.avisosDe(a) };
}

// ---------- Agências ----------
// A agência "vale o que custa" quando o custo do atendimento fica até a meta do faturamento das lojas dela.
const SITUACAO_DA_AGENCIA = {
  dentro: 'vale', fora: 'nao_vale', sem_faturamento: 'nao_vale',
  falta_faturamento: 'falta_faturamento', sem_cnpj: 'falta_faturamento', custo_nao_informado: 'custo_nao_informado',
};

async function agencias(query) {
  const a = await carregar(lerPeriodo(query), query, query.empresa);
  const total = somar(a.linhas, meta());
  const lista = [...agrupar(a.linhas, (l) => l.agencia)].map(([nome, ls]) => {
    const s = somar(ls, meta());
    const promotores = [...agrupar(ls, (l) => l.promotorId).values()].map((g) => {
      const sp = somar(g, meta());
      return {
        id: g[0].promotorId, nome: g[0].promotorNome, tipo: g[0].tipo,
        lojas: [...agrupar(g, (l) => l.lojaId).values()].map(resumoDaLoja).sort((x, y) => (y.custo ?? -1) - (x.custo ?? -1)),
        visitas: sp.visitas, custo: sp.custo, faturamento: sp.faturamento, percentual: sp.percentual, situacao: sp.situacao,
      };
    }).sort((x, y) => (y.custo ?? -1) - (x.custo ?? -1));
    return {
      nome,
      tipos: [...new Set(ls.map((l) => l.tipo))],
      qtdPromotores: promotores.length,
      qtdLojas: new Set(ls.map((l) => l.lojaId)).size,
      visitas: s.visitas, custo: s.custo, faturamento: s.faturamento, percentual: s.percentual,
      situacao: SITUACAO_DA_AGENCIA[s.situacao] || 'sem_dados',
      promotores,
    };
  }).sort((x, y) => (y.custo ?? -1) - (x.custo ?? -1) || x.nome.localeCompare(y.nome));
  return {
    meta: meta(),
    faturamento: total.faturamento, custo: total.custo, percentual: total.percentual,
    situacao: SITUACAO_DA_AGENCIA[total.situacao] || 'sem_dados',
    custoComparavel: total.custoComparavel, faturamentoComparavel: total.faturamentoComparavel,
    custoSemLoja: arred(soma(a.semLoja, 'custo')),
    agencias: lista,
    avisos: calc.avisosDe(a),
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
  if (ehSupervisor(dados.cargo)) throw new ErroDeValidacao('Supervisor não é promotor: cadastre na tela Supervisores.');
  if (!['CLT', 'MEI', 'AGENCIA', 'FREELANCER'].includes(dados.tipo)) throw new ErroDeValidacao('Escolha o tipo: CLT, MEI, Agência ou Freelancer.');
  const admissao = String(dados.admissao || '').trim();
  const problema = problemaNaData(admissao);
  if (problema) throw new ErroDeValidacao(`Data de admissão inválida (${problema}): ${admissao.slice(0, 20)}.`);
  const limpo = {
    nome,
    tipo: dados.tipo,
    agencia: String(dados.agencia || '').trim(),
    codigo: String(dados.codigo || '').trim(),
    cargo: String(dados.cargo || '').trim().slice(0, 60),
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

const COLUNAS_PROMOTOR = ['nome', 'tipo', 'agencia', 'codigo', 'cargo', 'empresa', 'regiao', 'admissao', 'telefone', 'observacao', 'ativo', ...CAMPOS_CUSTO];

// Salva o promotor pela tela (novo ou edição), numa transação só:
//  - salvo pela tela = cadastrado e identificado (pendente limpo);
//  - depois procura promotores pendentes que são a mesma pessoa (mesmo código + agência, ou mesmo nome sem acento)
//    e liga a ele: os atendimentos passam para este promotor e o duplicado é apagado.
// Devolve { id, ligados: [{ nome, agencia, atendimentos }] }.
async function salvarPromotor(id, dados) {
  const p = validarPromotor(dados);
  return transacao(async (rodar) => {
    const [repetido] = await rodar(
      'SELECT id FROM promotores WHERE lower(nome) = lower($1) AND lower(agencia) = lower($2) AND codigo = $3 AND id <> $4',
      [p.nome, p.agencia, p.codigo, id || 0],
    );
    if (repetido) throw new ErroDeValidacao('Já existe um promotor com esse nome, agência e código.');
    const valores = COLUNAS_PROMOTOR.map((c) => p[c]);
    let salvo = id;
    if (id) {
      const atribuicoes = COLUNAS_PROMOTOR.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const linhas = await rodar(`UPDATE promotores SET ${atribuicoes}, cadastrado = TRUE, pendente = '' WHERE id = $${valores.length + 1} RETURNING id`, [...valores, id]);
      if (!linhas.length) throw new ErroDeValidacao('Promotor não encontrado.');
    } else {
      const marcadores = COLUNAS_PROMOTOR.map((_, i) => `$${i + 1}`).join(', ');
      const [criado] = await rodar(`INSERT INTO promotores (${COLUNAS_PROMOTOR.join(', ')}, cadastrado, pendente) VALUES (${marcadores}, TRUE, '') RETURNING id`, valores);
      salvo = criado.id;
    }
    return { id: salvo, ligados: await ligarPendentesDe(rodar, salvo) };
  });
}

// Número inteiro positivo que cabe na coluna de id do banco. Qualquer outra coisa vira 0 (que não existe).
const idValido = (valor) => (Number.isInteger(valor) && valor > 0 && valor <= 2147483647 ? valor : 0);

// Lançamento manual de um atendimento (promotor + loja + mês). Se já existir, substitui.
async function salvarVisita({ promotorId, lojaId, mes, visitas, custo }) {
  if (!mesValido(mes)) throw new ErroDeValidacao('Informe o mês.');
  const qtd = Number(visitas);
  if (!Number.isInteger(qtd) || qtd < 0 || qtd > 999) throw new ErroDeValidacao('Quantidade de visitas inválida.');
  const valor = custo === '' || custo === null || custo === undefined ? null : dinheiro(custo, 'custo');
  const [[promotor], [loja]] = await Promise.all([
    consulta('SELECT id FROM promotores WHERE id = $1', [idValido(promotorId)]),
    consulta('SELECT id FROM lojas WHERE id = $1', [idValido(lojaId)]),
  ]);
  if (!promotor) throw new ErroDeValidacao('Promotor não encontrado.');
  if (!loja) throw new ErroDeValidacao('Escolha uma loja da lista.');
  await consulta(
    `INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (promotor_id, loja_id, mes) DO UPDATE SET qtd_visitas = EXCLUDED.qtd_visitas, custo = EXCLUDED.custo, importacao_id = NULL`,
    [promotor.id, loja.id, mes, qtd, valor],
  );
}

// Listas usadas nos filtros das telas. Fica guardada na memória da aba (ver comum.js), então pode ser maior.
async function opcoes() {
  const [mesesFat, mesesVis, empresas, promotores, lojas, supervisores] = await Promise.all([
    consulta('SELECT DISTINCT mes FROM faturamento_erp ORDER BY mes'),
    consulta('SELECT DISTINCT mes FROM visitas ORDER BY mes'),
    consulta("SELECT DISTINCT empresa FROM faturamento_erp WHERE empresa <> '' ORDER BY empresa"),
    consulta('SELECT DISTINCT p.agencia, p.empresa FROM promotores p'),
    consulta('SELECT DISTINCT l.nome, l.cidade, l.uf FROM lojas l WHERE EXISTS (SELECT 1 FROM visitas v WHERE v.loja_id = l.id)'),
    consulta('SELECT id, nome FROM supervisores ORDER BY nome'),
  ]);
  // Remove repetições que só diferem em maiúsculas/acentos ("SANTA HELENA" e "Santa Helena").
  const unicos = (valores) => {
    const vistos = new Map();
    for (const v of valores.map(texto).filter(Boolean)) if (!vistos.has(normalizar(v))) vistos.set(normalizar(v), v);
    return [...vistos.values()].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  };
  return {
    meta: config.meta,
    // Meses que têm cada tipo de dado. O Resumo só faz sentido num mês que tenha os dois.
    mesesFaturamento: mesesFat.map((m) => m.mes),
    mesesAtendimentos: mesesVis.map((m) => m.mes),
    meses: [...new Set([...mesesFat, ...mesesVis].map((m) => m.mes))].sort(),
    empresas: empresas.map((e) => e.empresa),
    agencias: unicos(promotores.map(agenciaDe)),
    ufs: unicos(lojas.map((l) => ufDe(l.uf) || l.uf)),
    municipios: unicos(lojas.map((l) => l.cidade)),
    mercados: unicos(lojas.map((l) => l.nome)),
    supervisores, // [{ id, nome }]: o filtro usa o id
  };
}

// Listas grandes, pedidas só pela tela que precisa delas.
const listaDeLojas = () => consulta('SELECT id, nome, cnpj, cidade FROM lojas ORDER BY nome');
const nomesDosPromotores = async () => (await consulta('SELECT id, nome, tipo, agencia, cargo FROM promotores WHERE ativo ORDER BY nome'))
  .filter((p) => !ehSupervisor(p.cargo)).map(({ cargo, ...p }) => p); // supervisor não aparece no seletor de promotor

module.exports = {
  resumo, faturamentoPorLoja, listaDePromotores, detalheDoPromotor, detalheDaLoja, detalheDoCliente, lojasPorUf, agencias, supervisoresDoPeriodo,
  salvarPromotor, salvarVisita, opcoes, listaDeLojas, nomesDosPromotores,
};
