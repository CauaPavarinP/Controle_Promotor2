// Testes das contas (não precisam de banco). Rodar: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcular, custoFixo, situacao } = require('../src/calculo');

const lojas = [{ id: 1, nome: 'Loja A' }, { id: 2, nome: 'Loja B' }, { id: 3, nome: 'Loja C' }];
const agencia = { id: 10, nome: 'Agência', tipo: 'AGENCIA' };
const clt = { id: 20, nome: 'Maria', tipo: 'CLT', salario: 1800, almoco: 200 };

test('custo fixo soma salário e adicionais', () => {
  assert.equal(custoFixo(clt), 2000);
  assert.equal(custoFixo({}), 0);
});

test('situação: até a meta está dentro; acima está fora', () => {
  assert.equal(situacao(30, 1000, 3), 'dentro'); // exatamente 3%
  assert.equal(situacao(30.01, 1000, 3), 'fora');
  assert.equal(situacao(50, 0, 3), 'sem_faturamento');
  assert.equal(situacao(0, 0, 3), 'sem_dados');
});

test('custo informado na planilha é usado como veio', () => {
  const r = calcular({
    promotores: [agencia], lojas, meta: 3,
    visitas: [
      { id: 1, promotor_id: 10, loja_id: 1, mes: '2026-10', qtd_visitas: 4, custo: 127.12 },
      { id: 2, promotor_id: 10, loja_id: 2, mes: '2026-10', qtd_visitas: 4, custo: 127.12 },
    ],
    faturamentos: [
      { loja_id: 1, mes: '2026-10', valor: 10000 },
      { loja_id: 2, mes: '2026-10', valor: 1000 },
      { loja_id: 3, mes: '2026-10', valor: 5000 }, // loja sem promotor
    ],
  });
  const p = r.promotores[0];
  assert.equal(p.custo, 254.24);
  assert.equal(p.faturamento, 11000);
  assert.equal(p.situacao, 'dentro'); // 2,31%
  assert.equal(p.lojas.find((l) => l.loja.id === 1).situacao, 'dentro'); // 1,27%
  assert.equal(p.lojas.find((l) => l.loja.id === 2).situacao, 'fora'); // 12,7%
  assert.equal(r.resumo.faturamentoTotal, 16000);
  assert.equal(r.resumo.faturamentoAtendido, 11000);
  assert.equal(r.resumo.dentro, 1);
  assert.equal(r.lojas.find((l) => l.loja.id === 3).situacao, 'sem_promotor');
});

test('sem custo na planilha, o custo fixo é dividido pelas visitas', () => {
  const r = calcular({
    promotores: [clt], lojas, meta: 3,
    visitas: [
      { id: 1, promotor_id: 20, loja_id: 1, mes: '2026-10', qtd_visitas: 6, custo: null },
      { id: 2, promotor_id: 20, loja_id: 2, mes: '2026-10', qtd_visitas: 2, custo: null },
    ],
    faturamentos: [{ loja_id: 1, mes: '2026-10', valor: 100000 }],
  });
  const p = r.promotores[0];
  assert.equal(p.custo, 2000);
  assert.equal(p.lojas.find((l) => l.loja.id === 1).custo, 1500); // 6 de 8 visitas
  assert.equal(p.lojas.find((l) => l.loja.id === 2).custo, 500);
  assert.equal(p.lojas.find((l) => l.loja.id === 2).situacao, 'sem_faturamento');
  assert.equal(p.situacao, 'dentro'); // 2000 / 100000 = 2%
});

test('o faturamento só conta nos meses em que o promotor atendeu a loja', () => {
  const r = calcular({
    promotores: [agencia], lojas, meta: 3,
    visitas: [{ id: 1, promotor_id: 10, loja_id: 1, mes: '2026-10', qtd_visitas: 4, custo: 100 }],
    faturamentos: [
      { loja_id: 1, mes: '2026-09', valor: 50000 }, // mês sem visita: não entra na conta do promotor
      { loja_id: 1, mes: '2026-10', valor: 2000 },
    ],
  });
  assert.equal(r.promotores[0].faturamento, 2000);
  assert.equal(r.promotores[0].percentual, 5);
  assert.equal(r.promotores[0].situacao, 'fora');
});

test('duas empresas faturando para a mesma loja no mês são somadas', () => {
  const r = calcular({
    promotores: [agencia], lojas, meta: 3,
    visitas: [{ id: 1, promotor_id: 10, loja_id: 1, mes: '2026-10', qtd_visitas: 4, custo: 90 }],
    faturamentos: [{ loja_id: 1, mes: '2026-10', valor: 2000 }, { loja_id: 1, mes: '2026-10', valor: 1000 }],
  });
  assert.equal(r.promotores[0].faturamento, 3000);
  assert.equal(r.promotores[0].situacao, 'dentro');
});

test('CLT com salário e sem nenhuma loja lançada: o custo conta e a situação é "sem lojas"', () => {
  const semLoja = { id: 30, nome: 'José', tipo: 'CLT', salario: 2500, ativo: true };
  const novato = { id: 31, nome: 'Novo', tipo: 'CLT', salario: 2500, ativo: true, admissao: '2026-11-03' }; // admitido depois do mês
  const inativo = { id: 32, nome: 'Saiu', tipo: 'CLT', salario: 2500, ativo: false };
  const r = calcular({
    promotores: [agencia, semLoja, novato, inativo], lojas, meta: 3,
    visitas: [{ id: 1, promotor_id: 10, loja_id: 1, mes: '2026-10', qtd_visitas: 4, custo: 100 }],
    faturamentos: [{ loja_id: 1, mes: '2026-10', valor: 10000 }],
  });
  const jose = r.promotores.find((p) => p.promotor.id === 30);
  assert.equal(jose.custo, 2500);
  assert.equal(jose.custoSemLoja, 2500);
  assert.equal(jose.situacao, 'sem_lojas');
  assert.equal(r.promotores.length, 2); // o admitido depois e o inativo não entram
  assert.equal(r.resumo.custoTotal, 2600);
  assert.equal(r.resumo.custoSemLojas, 2500);
  assert.equal(r.resumo.semLojas, 1);
  assert.equal(r.resumo.dentro, 1);
});

test('sem visitas informadas, o custo fixo é dividido em partes iguais entre as lojas', () => {
  const r = calcular({
    promotores: [clt], lojas, meta: 3,
    visitas: [
      { id: 1, promotor_id: 20, loja_id: 1, mes: '2026-10', qtd_visitas: 0, custo: null, dias_visita: 'Ter (1x/semana)' },
      { id: 2, promotor_id: 20, loja_id: 2, mes: '2026-10', qtd_visitas: 0, custo: null },
    ],
    faturamentos: [],
  });
  assert.deepEqual(r.promotores[0].lojas.map((l) => l.custo), [1000, 1000]);
  assert.equal(r.promotores[0].lojas.find((l) => l.loja.id === 1).dias, 'Ter (1x/semana)');
});
