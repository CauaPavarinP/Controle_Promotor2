// Testes da leitura de planilhas (não precisam de banco).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sugerirMapa, analisar, lerArquivo, numeroDe, cnpjDe, mesDe, montarPlanilha } = require('../src/planilha');

test('reconhece as colunas da planilha de agência', () => {
  const cabecalho = ['Estabelecimento', 'Cliente', 'Estab. CNPJ', 'Endereço', 'Estado', 'Segunda-feira', 'Vis. Mes', 'Vlr Mes'];
  assert.deepEqual(sugerirMapa(cabecalho, 'visitas'), { loja: 0, cnpj: 2, endereco: 3, uf: 4, visitas: 6, custo: 7 });
});

test('reconhece as colunas de um faturamento', () => {
  const cabecalho = ['Empresa', 'Cliente', 'CNPJ', 'Dt Emissão', 'Valor Total'];
  assert.deepEqual(sugerirMapa(cabecalho, 'faturamento'), { empresa: 0, loja: 1, cnpj: 2, data: 3, valor: 4 });
});

test('acha o cabeçalho mesmo com linhas de título antes', () => {
  const abas = [{ nome: 'A', linhas: [['Relatório de faturamento'], ['Período: 10/2026'], ['Cliente', 'CNPJ', 'Valor'], ['Loja', '1', 10]] }];
  const a = analisar(abas, 'faturamento');
  assert.equal(a.linhaCabecalho, 2);
  assert.equal(a.totalLinhas, 1);
});

test('números no padrão brasileiro', () => {
  assert.equal(numeroDe('R$ 1.234,56'), 1234.56);
  assert.equal(numeroDe('127,12'), 127.12);
  assert.equal(numeroDe(127.12), 127.12);
  assert.equal(numeroDe('1234.5'), 1234.5);
  assert.equal(numeroDe('abc'), null);
  assert.equal(numeroDe(''), null);
});

test('CNPJ: tira a pontuação e devolve os zeros que o Excel come', () => {
  assert.equal(cnpjDe('08.944.502/0002-63'), '08944502000263');
  assert.equal(cnpjDe(8944502000263), '08944502000263');
  assert.equal(cnpjDe('TOTAL'), '');
});

test('mês em vários formatos', () => {
  assert.equal(mesDe('15/10/2026'), '2026-10');
  assert.equal(mesDe('10/2026'), '2026-10');
  assert.equal(mesDe('2026-10-05'), '2026-10');
  assert.equal(mesDe('out/26'), '2026-10');
  assert.equal(mesDe('Outubro de 2026'), '2026-10');
  assert.equal(mesDe(new Date(Date.UTC(2026, 9, 31))), '2026-10');
  assert.equal(mesDe('qualquer coisa'), null);
});

test('lê CSV com ponto e vírgula e planilha .xlsx', async () => {
  const csv = await lerArquivo(Buffer.from('Cliente;Valor\n"Loja; A";"1.000,50"\n'), 'x.csv');
  assert.deepEqual(csv[0].linhas, [['Cliente', 'Valor'], ['Loja; A', '1.000,50']]);
  const xlsx = await montarPlanilha('Dados', [{ titulo: 'Loja', chave: 'loja' }, { titulo: 'Valor', chave: 'valor' }], [{ loja: 'A', valor: 10 }]);
  const abas = await lerArquivo(xlsx, 'x.xlsx');
  assert.deepEqual(abas[0].linhas, [['Loja', 'Valor'], ['A', 10]]);
  await assert.rejects(lerArquivo(Buffer.from('x'), 'antigo.xls'), /\.xls/);
});
