// Testes das contas (não precisam de banco). Rodar: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { analisar, somar, agrupar, avisosDe, custoFixo } = require('../src/calculo');

// CNPJs com dígito verificador certo (o cálculo confere o CNPJ das lojas).
const CNPJ_A = '11222333000181';
const CNPJ_B = '22222333000106';
const CNPJ_C = '33333444000106';

const lojas = [
  { id: 1, nome: 'Loja A', cnpj: CNPJ_A, cidade: 'Joinville', uf: 'SC' },
  { id: 2, nome: 'Rede B - Centro', cnpj: CNPJ_B, cidade: 'Curitiba', uf: 'PR' },
  { id: 3, nome: 'Rede B - Bairro', cnpj: CNPJ_B, cidade: 'Curitiba', uf: 'Paraná' }, // mesmo CNPJ (compra pela matriz)
  { id: 4, nome: 'Loja sem CNPJ', cnpj: null, cidade: 'Lapa', uf: 'PR' },
  { id: 5, nome: 'Loja CNPJ errado', cnpj: '11222333000182', cidade: 'Lapa', uf: 'PR' },
];
const agencia = { id: 10, nome: 'JOAO', tipo: 'AGENCIA', agencia: 'Agência X', ativo: true };
const outro = { id: 11, nome: 'MARIA', tipo: 'AGENCIA', agencia: 'Agência Y', ativo: true };
const clt = { id: 20, nome: 'Carlos', tipo: 'CLT', agencia: 'Filial PR', salario: 1800, almoco: 200, ativo: true };
const semValor = { id: 30, nome: 'Freela', tipo: 'FREELANCER', agencia: 'Freela Z', ativo: true };
let proximoId = 1;
const visita = (promotor, loja, mes, custo, visitas = 4) => ({ id: proximoId++, promotor_id: promotor, loja_id: loja, mes, qtd_visitas: visitas, custo });
const base = (extra) => ({ promotores: [agencia, outro, clt, semValor], lojas, meta: 3, de: '2026-10', ate: '2026-10', mesesComErp: ['2026-10'], ...extra });
const soma = (lista, campo) => Math.round(lista.reduce((t, x) => t + (x[campo] || 0), 0) * 100) / 100;

test('custo fixo soma salário e adicionais', () => {
  assert.equal(custoFixo(clt), 2000);
  assert.equal(custoFixo({}), 0);
});

test('CNPJ repetido: o faturamento é dividido igualmente entre as lojas do CNPJ e, na loja, entre os promotores', () => {
  const a = analisar(base({
    visitas: [visita(10, 2, '2026-10', 100), visita(10, 3, '2026-10', 100), visita(11, 3, '2026-10', 50)],
    faturamentos: [{ cnpj: CNPJ_B, mes: '2026-10', valor: 10000 }],
  }));
  const fat = Object.fromEntries(a.linhas.map((l) => [`${l.promotorId}@${l.lojaId}`, l.faturamento]));
  // 10.000 / 2 lojas = 5.000 por loja. A loja 3 tem 2 promotores: 2.500 para cada.
  assert.deepEqual(fat, { '10@2': 5000, '10@3': 2500, '11@3': 2500 });
  assert.equal(soma(a.linhas, 'faturamento'), 10000); // a mesma compra não conta duas vezes
  assert.ok(a.linhas.every((l) => l.lojasDoCnpj === 2));
  // A soma por promotor bate com o total.
  const porPromotor = [...agrupar(a.linhas, (l) => l.promotorId).values()].map((ls) => somar(ls, 3));
  assert.deepEqual(porPromotor.map((s) => s.faturamento), [7500, 2500]);
  assert.ok(avisosDe(a).some((x) => x.id === 'cnpj_dividido'));
});

test('a divisão do CNPJ é por mês: num mês com uma loja só, ela fica com tudo', () => {
  const a = analisar(base({
    de: '2026-09', ate: '2026-10', mesesComErp: ['2026-09', '2026-10'],
    visitas: [visita(10, 2, '2026-09', 100), visita(10, 2, '2026-10', 100), visita(10, 3, '2026-10', 100)],
    faturamentos: [{ cnpj: CNPJ_B, mes: '2026-09', valor: 4000 }, { cnpj: CNPJ_B, mes: '2026-10', valor: 6000 }],
  }));
  const fat = Object.fromEntries(a.linhas.map((l) => [`${l.lojaId}@${l.mes}`, l.faturamento]));
  assert.deepEqual(fat, { '2@2026-09': 4000, '2@2026-10': 3000, '3@2026-10': 3000 });
});

test('loja sem CNPJ válido fica com faturamento zero (e o custo dela pesa no %)', () => {
  const a = analisar(base({
    visitas: [visita(10, 1, '2026-10', 100), visita(10, 4, '2026-10', 100), visita(10, 5, '2026-10', 100)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 10000 }, { cnpj: '11222333000182', mes: '2026-10', valor: 999 }],
  }));
  const porLoja = Object.fromEntries([...agrupar(a.linhas, (l) => l.lojaId)].map(([id, ls]) => [id, somar(ls, 3)]));
  assert.deepEqual([porLoja[4].faturamento, porLoja[4].situacao], [0, 'sem_cnpj']);
  assert.deepEqual([porLoja[5].faturamento, porLoja[5].situacao], [0, 'sem_cnpj']); // CNPJ com dígito errado
  assert.equal(porLoja[1].situacao, 'dentro'); // 100 / 10.000 = 1%
  // No total, o custo das lojas sem CNPJ entra: 300 / 10.000 = 3% (no limite).
  const total = somar(a.linhas, 3);
  assert.equal(total.percentual, 3);
  // O faturamento do CNPJ errado no ERP fica sem loja atendida, não some.
  assert.equal(soma(a.naoAlocado, 'valor'), 999);
  assert.ok(avisosDe(a).find((x) => x.id === 'sem_cnpj').texto.startsWith('2 loja(s)'));
});

test('mês sem faturamento do ERP: faturamento "—" (null), fora do %, situação "falta o faturamento"', () => {
  const a = analisar(base({
    de: '2026-09', ate: '2026-10', mesesComErp: ['2026-09'],
    visitas: [visita(10, 1, '2026-09', 100), visita(10, 1, '2026-10', 500)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-09', valor: 10000 }],
  }));
  const out = a.linhas.find((l) => l.mes === '2026-10');
  assert.equal(out.faturamento, null);
  assert.equal(somar([out], 3).situacao, 'falta_faturamento');
  const total = somar(a.linhas, 3);
  assert.equal(total.custo, 600); // o custo de outubro conta no custo...
  assert.equal(total.percentual, 1); // ...mas não no %: só setembro (100 / 10.000)
  assert.equal(total.faturamento, 10000);
  assert.ok(avisosDe(a).find((x) => x.id === 'meses_sem_erp').texto.includes('out/2026'));
});

test('sem valor do mês: CLT usa o salário do cadastro; quem não tem cadastro fica "custo não informado"', () => {
  const a = analisar(base({
    visitas: [visita(20, 1, '2026-10', null, 6), visita(20, 2, '2026-10', null, 2), visita(30, 1, '2026-10', null)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 100000 }],
  }));
  const carlos = a.linhas.filter((l) => l.promotorId === 20);
  assert.deepEqual(carlos.map((l) => [l.custo, l.origemCusto]), [[1500, 'cadastro'], [500, 'cadastro']]); // 6 e 2 de 8 visitas
  const freela = a.linhas.find((l) => l.promotorId === 30);
  assert.equal(freela.custo, null);
  const sf = somar([freela], 3);
  assert.deepEqual([sf.custo, sf.situacao, sf.percentual], [null, 'custo_nao_informado', null]);
  // O "não informado" não vira zero no %: a loja 1 compara só o custo do Carlos com a parte dele.
  const loja1 = somar(a.linhas.filter((l) => l.lojaId === 1), 3);
  assert.equal(loja1.custoComparavel, 1500);
  assert.equal(loja1.faturamentoComparavel, 50000); // 100.000 / 2 promotores
  const av = avisosDe(a).find((x) => x.id === 'custo_nao_informado');
  assert.match(av.texto, /2 usam o salário do cadastro.*1 ficaram com a situação "custo não informado"/);
});

test('filtro de UF: só as lojas da UF; o custo do promotor é só a parte dele nelas', () => {
  const dados = base({
    visitas: [visita(10, 1, '2026-10', 100), visita(10, 2, '2026-10', 300)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 5000 }, { cnpj: CNPJ_B, mes: '2026-10', valor: 9000 }, { cnpj: CNPJ_C, mes: '2026-10', valor: 700 }],
    clientes: [{ cnpj: CNPJ_C, nome: 'Cliente SC', cidade: 'Joinville', uf: 'SC' }],
  });
  const sc = analisar({ ...dados, filtros: { uf: 'SC' } });
  assert.deepEqual(sc.linhas.map((l) => l.lojaId), [1]);
  assert.equal(somar(sc.linhas, 3).custo, 100);
  assert.deepEqual(sc.naoAlocado.map((n) => n.cnpj), [CNPJ_C]); // cliente do ERP sem atendimento, da UF filtrada
  const pr = analisar({ ...dados, filtros: { uf: 'Paraná' } }); // aceita a UF por extenso
  assert.deepEqual(pr.linhas.map((l) => l.lojaId), [2]);
  assert.equal(pr.naoAlocado.length, 0);
  // Filtro de agência: o faturamento sem atendimento não pertence a nenhuma agência.
  assert.equal(analisar({ ...dados, filtros: { agencia: 'agência x' } }).naoAlocado.length, 0);
  assert.equal(analisar({ ...dados, filtros: { mercado: 'rede b' } }).linhas.length, 1);
  assert.equal(analisar({ ...dados, filtros: { municipio: 'JOINVILLE' } }).linhas.length, 1);
});

test('sem filtro, a soma das linhas + o faturamento sem atendimento = o total do ERP', () => {
  const a = analisar(base({
    visitas: [visita(10, 1, '2026-10', 100), visita(10, 2, '2026-10', 100), visita(11, 3, '2026-10', 100), visita(10, 4, '2026-10', 100)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 1234.56 }, { cnpj: CNPJ_B, mes: '2026-10', valor: 1000 }, { cnpj: CNPJ_C, mes: '2026-10', valor: 333.33 }],
  }));
  assert.equal(Math.round((soma(a.linhas, 'faturamento') + soma(a.naoAlocado, 'valor')) * 100) / 100, a.faturamentoErp);
  assert.equal(a.faturamentoErp, 2567.89);
});

test('comprou em mês sem atendimento: o valor fica fora do % e aparece no aviso', () => {
  const a = analisar(base({
    de: '2026-09', ate: '2026-10', mesesComErp: ['2026-09', '2026-10'],
    visitas: [visita(10, 1, '2026-10', 100)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-09', valor: 8000 }, { cnpj: CNPJ_A, mes: '2026-10', valor: 5000 }],
  }));
  assert.equal(somar(a.linhas, 3).faturamento, 5000);
  assert.deepEqual(a.naoAlocado.map((n) => [n.mes, n.valor, n.atendidoNoPeriodo]), [['2026-09', 8000, true]]);
  const avisos = avisosDe(a);
  assert.match(avisos.find((x) => x.id === 'compras_sem_atendimento').texto, /R\$\s8\.000,00 ficaram fora do %/);
  assert.match(avisos.find((x) => x.id === 'meses_sem_atendimento').texto, /set\/2026/);
});

test('CLT com salário e sem loja lançada: entra no custo total, fora do %; não entra com filtro de loja', () => {
  const novato = { id: 31, nome: 'Novo', tipo: 'CLT', salario: 2500, ativo: true, admissao: '2026-11-03' }; // admitido depois
  const inativo = { id: 32, nome: 'Saiu', tipo: 'CLT', salario: 2500, ativo: false };
  const dados = base({
    promotores: [agencia, clt, novato, inativo],
    visitas: [visita(10, 1, '2026-10', 100)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 10000 }],
  });
  const a = analisar(dados);
  assert.deepEqual(a.semLoja.map((s) => [s.promotorId, s.custo]), [[20, 2000]]);
  const total = somar(a.linhas, 3, soma(a.semLoja, 'custo'));
  assert.deepEqual([total.custo, total.custoSemLoja, total.percentual], [2100, 2000, 1]);
  assert.equal(somar([], 3, 2000).situacao, 'sem_lojas');
  assert.equal(analisar({ ...dados, filtros: { uf: 'SC' } }).semLoja.length, 0);
  assert.equal(analisar({ ...dados, filtros: { tipo: 'AGENCIA' } }).semLoja.length, 0);
  assert.equal(analisar({ ...dados, filtros: { tipo: 'CLT' } }).semLoja.length, 1);
});

test('situações: dentro, fora e sem faturamento', () => {
  const a = analisar(base({
    visitas: [visita(10, 1, '2026-10', 300), visita(11, 2, '2026-10', 301), visita(10, 3, '2026-10', 50)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 10000 }, { cnpj: CNPJ_B, mes: '2026-10', valor: 0 }],
  }));
  const porLoja = Object.fromEntries([...agrupar(a.linhas, (l) => l.lojaId)].map(([id, ls]) => [id, somar(ls, 3).situacao]));
  assert.deepEqual(porLoja, { 1: 'dentro', 2: 'sem_faturamento', 3: 'sem_faturamento' }); // 300 / 10.000 = 3%: dentro (no limite)
  assert.equal(somar([{ ...a.linhas[0], custo: 300.01 }], 3).situacao, 'fora');
});

test('supervisor não entra no custo dos promotores nem em "sem loja lançada"', () => {
  const supervisora = { id: 40, nome: 'Joana', tipo: 'CLT', cargo: 'Sup ll', salario: 5000, ativo: true };
  const a = analisar(base({
    promotores: [agencia, supervisora],
    visitas: [visita(10, 1, '2026-10', 100), visita(40, 2, '2026-10', null)],
    faturamentos: [{ cnpj: CNPJ_A, mes: '2026-10', valor: 10000 }],
  }));
  assert.equal(a.linhas.find((l) => l.promotorId === 40).custo, null); // salário de supervisor não vira custo de loja
  const semSup = analisar(base({ promotores: [agencia, supervisora], visitas: [visita(10, 1, '2026-10', 100)], faturamentos: [] }));
  assert.equal(semSup.semLoja.length, 0);
});

test('aviso: atendimento com código que não achou ninguém no cadastro', () => {
  const doAtendimento = { id: 50, nome: 'ZECA', tipo: 'CLT', agencia: 'Filial', codigo: '99', cadastrado: false, ativo: true };
  const doCadastro = { id: 51, nome: 'Pedro', tipo: 'CLT', agencia: 'Filial', codigo: '06', cadastrado: true, salario: 2000, ativo: true };
  const a = analisar(base({
    promotores: [doAtendimento, doCadastro],
    visitas: [visita(50, 1, '2026-10', null), visita(51, 1, '2026-10', null)],
    faturamentos: [],
  }));
  const av = avisosDe(a).find((x) => x.id === 'codigo_sem_cadastro');
  assert.deepEqual(av.itens, ['Filial — ZECA (código 99): 1 loja(s)']);
});
