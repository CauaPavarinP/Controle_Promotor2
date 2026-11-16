// Testes da leitura de planilhas (não precisam de banco).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sugerirMapa, analisar, lerXlsx, lerTexto, criarLeitor, criarAgrupador, numeroDe, cnpjDe, mesDe, montarPlanilha } = require('../src/planilha');

test('reconhece as colunas da planilha de agência', () => {
  const cabecalho = ['Estabelecimento', 'Cliente', 'Estab. CNPJ', 'Endereço', 'Estado', 'Segunda-feira', 'Vis. Mes', 'Vlr Mes'];
  assert.deepEqual(sugerirMapa(cabecalho, 'visitas'), { loja: 0, cnpj: 2, endereco: 3, uf: 4, visitas: 6, custo: 7 });
});

test('reconhece as colunas de um faturamento', () => {
  const cabecalho = ['Empresa', 'Cliente', 'CNPJ', 'Dt Emissão', 'Valor Total'];
  assert.deepEqual(sugerirMapa(cabecalho, 'faturamento'), { empresa: 0, loja: 1, cnpj: 2, data: 3, valor: 4 });
});

test('acha o cabeçalho mesmo com linhas de título antes', () => {
  const a = analisar([['Relatório de faturamento'], ['Período: 10/2026'], ['Cliente', 'CNPJ', 'Valor'], ['Loja', '1', 10]], 'faturamento');
  assert.equal(a.linhaCabecalho, 2);
  assert.equal(a.amostra.length, 1);
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
  assert.equal(mesDe('qualquer coisa'), null);
});

test('lê CSV com ponto e vírgula e planilha .xlsx', async () => {
  assert.deepEqual(lerTexto('Cliente;Valor\r\n"Loja; A";"1.000,50"\r\n', 'csv'), [['Cliente', 'Valor'], ['Loja; A', '1.000,50']]);
  const xlsx = await montarPlanilha('Dados', [{ titulo: 'Loja', chave: 'loja' }, { titulo: 'Valor', chave: 'valor' }, { titulo: 'Data', chave: 'data' }],
    [{ loja: 'A', valor: 10, data: new Date(Date.UTC(2026, 9, 31)) }]);
  const abas = await lerXlsx(xlsx);
  assert.deepEqual(abas[0].linhas, [['Loja', 'Valor', 'Data'], ['A', 10, '31/10/2026']]);
  await assert.rejects(lerXlsx(Buffer.from('isto não é planilha')), /Não consegui abrir/);
});

// Monta um relatório no formato do FoccoERP: um ".xls" que por dentro é uma tabela HTML.
const TITULOS_FOCCO = ['COD EMP', 'DT EMIS', 'ANO', 'MES', 'NUM NF', 'CNPJ CPF', 'CLIENTE', 'CIDADE', 'UF', 'VLR MERCADORIA', 'VLR TOTAL', 'G TOTAL GERAL'];
function relatorioFocco(notas) {
  const celula = (v) => `<td ALIGN="RIGHT" valign="top"><font face="Arial" size="-3">${v}</font></td>`;
  return `<HTML>\r\n<HEAD>\r\n<TITLE>Gerador de Relat\u00f3rios Focco3i</TITLE>\r\n</HEAD>\r\n<BODY><h1>Relatorio</h1><table border="1"><TR>\r\n${
    TITULOS_FOCCO.map((t) => celula(`<b>${t}</b>`)).join('\r\n')}\r\n</TR>\r\n${
    notas.map((n) => `<TR>\r\n${n.map(celula).join('\r\n')}\r\n</TR>`).join('\r\n')}\r\n</TABLE>\r\n</BODY>\r\n</HTML>`;
}

test('lê o .xls do FoccoERP (tabela HTML) e reconhece as colunas', () => {
  const linhas = lerTexto(relatorioFocco([
    ['63', '05/10/2026', '2026', '10', '123', '08944502000263', 'MERCADO S&amp;A&nbsp;LTDA', 'S\u00e3o Carlos', 'SP', '900,00', '1.000,50', ''],
  ]), 'html');
  assert.equal(linhas.length, 2);
  assert.equal(linhas[1][6], 'MERCADO S&A LTDA');
  const a = analisar(linhas, 'faturamento');
  assert.equal(a.linhaCabecalho, 0);
  assert.deepEqual(a.mapa, { cnpj: 5, loja: 6, valor: 10, data: 1, empresa: 0, cidade: 7, uf: 8 });
  assert.equal(mesDe(linhas[1][a.mapa.data]), '2026-10');
  assert.equal(numeroDe(linhas[1][a.mapa.valor]), 1000.5);
});

test('arquivo grande lido em pedaços dá o mesmo resultado, mesmo cortando no meio de uma célula', () => {
  // 3000 notas de 50 clientes em 2 meses.
  const notas = [];
  for (let i = 0; i < 3000; i++) {
    const cliente = i % 50;
    notas.push(['63', `${String((i % 28) + 1).padStart(2, '0')}/${Math.floor(i / 50) % 2 ? '10' : '09'}/2026`, '2026', '', String(i),
      String(11000000000100 + cliente), `CLIENTE ${cliente}`, 'Rio Claro', 'SP', '90,00', '100,00', '']);
  }
  const html = relatorioFocco(notas);
  const mapa = analisar(lerTexto(html, 'html').slice(0, 200), 'faturamento').mapa;

  const somar = (tamanhoDoPedaco) => {
    const leitor = criarLeitor('html');
    const agrupador = criarAgrupador('faturamento', mapa, {});
    let numero = 0;
    const consumir = (linhas) => { for (const linha of linhas) if (numero++ > 0) agrupador.adicionar(linha); };
    for (let i = 0; i < html.length; i += tamanhoDoPedaco) consumir(leitor.receber(html.slice(i, i + tamanhoDoPedaco)));
    consumir(leitor.terminar());
    return agrupador.resultado();
  };

  const inteiro = somar(html.length);
  assert.equal(inteiro.itens.length, 100); // 50 clientes x 2 meses
  assert.equal(inteiro.itens.reduce((s, i) => s + i.valor, 0), 300000); // 3000 notas de R$ 100
  assert.deepEqual(inteiro.motivos, {});
  for (const pedaco of [7, 1000, 65536]) assert.deepEqual(somar(pedaco), inteiro);
});

test('agrupador de visitas: soma, ignora a linha de total e usa o promotor da tela', () => {
  const agrupador = criarAgrupador('visitas', { loja: 0, cnpj: 1, visitas: 2, custo: 3 }, { mes: '2026-10', promotorId: 7 });
  [['Mercado Um', '11111111000111', 4, 127.12], ['Mercado Um', '11111111000111', 2, 50], ['', '', 'TOTAL', 177.12]].forEach(agrupador.adicionar);
  const { itens, motivos } = agrupador.resultado();
  assert.equal(itens.length, 1);
  assert.deepEqual({ promotor: itens[0].promotor, mes: itens[0].mes, visitas: itens[0].visitas, custo: itens[0].custo },
    { promotor: { id: 7 }, mes: '2026-10', visitas: 6, custo: 177.12 });
  assert.deepEqual(motivos, { 'Sem loja (linha de total ou em branco)': 1 });
  assert.throws(() => criarAgrupador('faturamento', { loja: 0 }, {}), /valor faturado/);
});
