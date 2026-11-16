// Regras de cálculo do sistema. Este arquivo não acessa o banco: recebe listas e devolve os totais.
// Assim dá para testar as contas sem precisar de banco de dados.

const CAMPOS_CUSTO = ['salario', 'periculosidade', 'ajuda_celular', 'ajuda_custo', 'almoco', 'vale_transporte', 'gratificacao', 'outros_custos'];

// Custo fixo mensal do cadastro do promotor (salário + periculosidade + ajudas + almoço + VT + gratificação + outros).
function custoFixo(promotor) {
  return CAMPOS_CUSTO.reduce((soma, campo) => soma + (Number(promotor[campo]) || 0), 0);
}

function arredondar(valor) {
  return Math.round(valor * 100) / 100;
}

// Percentual do custo sobre o faturamento. Sem faturamento não dá para calcular (null).
function percentual(custo, faturamento) {
  return faturamento > 0 ? (custo / faturamento) * 100 : null;
}

// dentro = custou até a meta | fora = passou da meta
// sem_faturamento = teve custo mas a loja não faturou | sem_dados = não teve custo nem faturamento
// (existe ainda "sem_lojas": promotor com custo fixo e nenhuma loja lançada; ver "calcular")
function situacao(custo, faturamento, meta) {
  if (faturamento <= 0) return custo > 0 ? 'sem_faturamento' : 'sem_dados';
  return percentual(custo, faturamento) <= meta ? 'dentro' : 'fora';
}

// Descobre o custo de cada atendimento (promotor + loja + mês).
// 1) Se a planilha trouxe o custo, vale o custo da planilha.
// 2) Se não trouxe, usa o custo fixo do cadastro do promotor, dividido pelas lojas
//    na proporção das visitas daquele mês.
function custosDosAtendimentos(visitas, promotoresPorId) {
  const grupos = new Map(); // um grupo por promotor + mês
  for (const visita of visitas) {
    const chave = `${visita.promotor_id}|${visita.mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(visita);
  }

  const resultado = [];
  for (const grupo of grupos.values()) {
    const temCustoInformado = grupo.some((v) => v.custo !== null && v.custo !== undefined);
    const fixo = custoFixo(promotoresPorId.get(grupo[0].promotor_id) || {});
    const totalVisitas = grupo.reduce((soma, v) => soma + v.qtd_visitas, 0);
    for (const visita of grupo) {
      let custo;
      if (temCustoInformado) custo = Number(visita.custo) || 0;
      else if (totalVisitas > 0) custo = (fixo * visita.qtd_visitas) / totalVisitas;
      else custo = fixo / grupo.length;
      resultado.push({ ...visita, custo, custoInformado: temCustoInformado });
    }
  }
  return resultado;
}

// Junta tudo: visitas + faturamento do período => totais por promotor, por loja e gerais.
function calcular({ promotores, lojas, visitas, faturamentos, meta }) {
  const promotoresPorId = new Map(promotores.map((p) => [p.id, p]));
  const lojasPorId = new Map(lojas.map((l) => [l.id, l]));

  // Faturamento de cada loja em cada mês (somando as empresas) e no período todo.
  const fatLojaMes = new Map();
  const fatLoja = new Map();
  let faturamentoTotal = 0;
  for (const f of faturamentos) {
    const chave = `${f.loja_id}|${f.mes}`;
    fatLojaMes.set(chave, (fatLojaMes.get(chave) || 0) + f.valor);
    fatLoja.set(f.loja_id, (fatLoja.get(f.loja_id) || 0) + f.valor);
    faturamentoTotal += f.valor;
  }

  const porPromotor = new Map();
  const porLoja = new Map();
  const lojaMesAtendida = new Set();
  let custoTotal = 0;

  const linhaPromotor = (promotorId) => {
    if (!porPromotor.has(promotorId)) {
      porPromotor.set(promotorId, {
        promotor: promotoresPorId.get(promotorId), custo: 0, faturamento: 0, visitas: 0, custoSemLoja: 0, lojas: new Map(),
      });
    }
    return porPromotor.get(promotorId);
  };

  const linhaLoja = (lojaId) => {
    if (!porLoja.has(lojaId)) {
      porLoja.set(lojaId, {
        loja: lojasPorId.get(lojaId), faturamento: fatLoja.get(lojaId) || 0, custo: 0, visitas: 0, promotores: new Set(),
      });
    }
    return porLoja.get(lojaId);
  };

  for (const at of custosDosAtendimentos(visitas, promotoresPorId)) {
    // O faturamento que conta para o promotor é o da loja NO MÊS em que ele atendeu.
    const faturamento = fatLojaMes.get(`${at.loja_id}|${at.mes}`) || 0;
    lojaMesAtendida.add(`${at.loja_id}|${at.mes}`);
    custoTotal += at.custo;

    const p = linhaPromotor(at.promotor_id);
    p.custo += at.custo;
    p.faturamento += faturamento;
    p.visitas += at.qtd_visitas;
    if (!p.lojas.has(at.loja_id)) {
      p.lojas.set(at.loja_id, { loja: lojasPorId.get(at.loja_id), visitas: 0, custo: 0, faturamento: 0, dias: '', atendimentos: [] });
    }
    const pl = p.lojas.get(at.loja_id);
    pl.visitas += at.qtd_visitas;
    pl.custo += at.custo;
    pl.faturamento += faturamento;
    pl.dias = pl.dias || at.dias_visita || ''; // ex.: "Ter, Sex (2x/semana)"
    pl.atendimentos.push({ id: at.id, mes: at.mes, visitas: at.qtd_visitas, custo: arredondar(at.custo), faturamento, custoInformado: at.custoInformado });

    const l = linhaLoja(at.loja_id);
    l.custo += at.custo;
    l.visitas += at.qtd_visitas;
    l.promotores.add(at.promotor_id);
  }
  for (const lojaId of fatLoja.keys()) linhaLoja(lojaId); // lojas que faturaram mas não têm promotor

  // Promotor com custo fixo no cadastro (ex.: CLT com salário) e SEM nenhuma loja lançada no mês:
  // o salário foi pago do mesmo jeito, então o custo entra na conta, mesmo sem faturamento para comparar.
  // Só vale para os meses que já têm visitas importadas (para não inventar custo em mês ainda não lançado).
  const mesesLancados = [...new Set(visitas.map((v) => v.mes))];
  const atendeuNoMes = new Set(visitas.map((v) => `${v.promotor_id}|${v.mes}`));
  for (const promotor of promotores) {
    const fixo = custoFixo(promotor);
    if (promotor.ativo === false || fixo <= 0) continue;
    for (const mes of mesesLancados) {
      if (atendeuNoMes.has(`${promotor.id}|${mes}`)) continue;
      if (promotor.admissao && promotor.admissao.slice(0, 7) > mes) continue; // ainda não tinha sido admitido
      const p = linhaPromotor(promotor.id);
      p.custo += fixo;
      p.custoSemLoja += fixo;
      custoTotal += fixo;
    }
  }

  const fechar = (linha) => {
    linha.custo = arredondar(linha.custo);
    linha.faturamento = arredondar(linha.faturamento);
    linha.percentual = percentual(linha.custo, linha.faturamento);
    linha.situacao = situacao(linha.custo, linha.faturamento, meta);
    return linha;
  };

  const listaPromotores = [...porPromotor.values()].map((p) => {
    p.lojas = [...p.lojas.values()].map(fechar).sort((a, b) => b.custo - a.custo);
    p.qtdLojas = p.lojas.length;
    p.custoSemLoja = arredondar(p.custoSemLoja);
    fechar(p);
    if (p.qtdLojas === 0) p.situacao = 'sem_lojas'; // tem custo, mas não sabemos quais lojas atende
    return p;
  });

  const listaLojas = [...porLoja.values()].map((l) => {
    l.qtdPromotores = l.promotores.size;
    delete l.promotores;
    fechar(l);
    if (l.qtdPromotores === 0) l.situacao = 'sem_promotor';
    return l;
  });

  let faturamentoAtendido = 0;
  for (const chave of lojaMesAtendida) faturamentoAtendido += fatLojaMes.get(chave) || 0;

  const contar = (s) => listaPromotores.filter((p) => p.situacao === s).length;
  const resumo = {
    meta,
    faturamentoTotal: arredondar(faturamentoTotal),
    faturamentoAtendido: arredondar(faturamentoAtendido),
    custoTotal: arredondar(custoTotal),
    percentual: percentual(custoTotal, faturamentoAtendido),
    situacao: situacao(custoTotal, faturamentoAtendido, meta),
    promotores: listaPromotores.length,
    dentro: contar('dentro'),
    fora: contar('fora'),
    semFaturamento: contar('sem_faturamento'),
    semLojas: contar('sem_lojas'),
    custoSemLojas: arredondar(listaPromotores.reduce((soma, p) => soma + p.custoSemLoja, 0)),
  };

  return { resumo, promotores: listaPromotores, lojas: listaLojas };
}

module.exports = { calcular, custoFixo, percentual, situacao, CAMPOS_CUSTO };
