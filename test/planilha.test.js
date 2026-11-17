// Testes da leitura de planilhas (não precisam de banco).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sugerirMapa, analisar, lerXlsx, lerTexto, criarLeitor, criarAgrupador, numeroDe, cnpjDe, cnpjValido, mesDe, montarPlanilha } = require('../src/planilha');

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
  [['Mercado Um', '11.222.333/0001-81', 4, 127.12], ['Mercado Um', '11222333000181', 2, 50], ['', '', 'TOTAL', 177.12]].forEach(agrupador.adicionar);
  const { itens, motivos } = agrupador.resultado();
  assert.equal(itens.length, 1);
  assert.deepEqual({ promotor: itens[0].promotor, mes: itens[0].mes, visitas: itens[0].visitas, custo: itens[0].custo },
    { promotor: { id: 7 }, mes: '2026-10', visitas: 6, custo: 177.12 });
  assert.deepEqual(motivos, { 'Sem loja (linha de total ou em branco)': 1 });
  assert.throws(() => criarAgrupador('faturamento', { loja: 0 }, {}), /valor faturado/);
});

// ---------- Modelo padrão de atendimento (planilha consolidada das agências) ----------
const TITULOS_MODELO = ['Mês de referência', 'Agência ou MEI', 'Tipo', 'CNPJ da loja', 'Loja', 'Cidade', 'UF', 'Promotor', 'Código do promotor',
  'Dias de visita', 'Visitas no mês', 'Valor do mês (R$)', 'Status', 'Observação', 'Supervisor', 'Conferência do CNPJ'];

test('confere os dígitos do CNPJ', () => {
  assert.equal(cnpjValido('11222333000181'), true);
  assert.equal(cnpjValido('11222333000182'), false); // último dígito trocado
  assert.equal(cnpjValido('11111111111111'), false);
  assert.equal(cnpjValido('1122233300018'), false);
});

test('modelo padrão: reconhece as colunas da aba Atendimentos', () => {
  assert.deepEqual(sugerirMapa(TITULOS_MODELO, 'visitas'), {
    data: 0, agencia: 1, tipo: 2, cnpj: 3, loja: 4, cidade: 5, uf: 6, promotor: 7, codigo: 8, dias: 9, visitas: 10, custo: 11, status: 12, observacao: 13, supervisor: 14,
  });
});

test('modelo padrão: promotor, agência, CNPJ errado e loja sem CNPJ', () => {
  const mapa = sugerirMapa(TITULOS_MODELO, 'visitas');
  const agrupador = criarAgrupador('visitas', mapa, {});
  [
    ['10/2026', 'Agência A', 'Agência', '11.222.333/0001-81', 'Loja 1', 'Rio Claro', 'SP', 'JOAO', '', 'Ter (1x/semana)', '', 80, 'Ativa', 'obs', '', 'OK'],
    ['10/2026', 'Agência B', 'Agência', '11.222.333/0001-81', 'Loja 1', 'Rio Claro', 'SP', 'JOAO', '', '', 4, 90, 'Ativa', '', '', 'OK'], // outro João, de outra agência
    ['10/2026', 'AKTO', 'Agência', '11.222.333/0001-82', 'Loja 2', 'Sorocaba', 'SP', '', '', '2x/semana', '', 159.54, 'Ativa', '', '', 'Verificar'], // CNPJ errado, sem promotor
    ['10/2026', 'Filial PR (CLT)', 'CLT', '', 'Condor', 'Curitiba', 'PR', 'MARIA', '30', 'Seg', '', '', '', '', 'Sup', ''], // sem CNPJ e sem valor
    ['10/2026', 'Filial PR (CLT)', 'CLT', '', 'Condor', 'Lapa', 'PR', 'MARIA', '30', 'Qua', '', '', '', '', 'Sup', ''], // mesmo nome de loja, outra cidade
    ['10/2026', 'MEI X', 'Freelancer', '', 'Mercado Z', '', '', 'ANA', '', '', '', 250, 'Ativa', '', '', ''],
  ].forEach(agrupador.adicionar);
  const { itens, avisos, motivos } = agrupador.resultado();
  assert.equal(itens.length, 6);
  assert.deepEqual(motivos, {});
  // Os dois "JOAO" são promotores diferentes, porque são de agências diferentes.
  assert.deepEqual(itens.slice(0, 2).map((i) => `${i.promotor.nome}/${i.promotor.agencia}`), ['JOAO/Agência A', 'JOAO/Agência B']);
  assert.equal(itens[0].dias, 'Ter (1x/semana)');
  // Sem nome de promotor, o "promotor" é a própria agência; o CNPJ errado entra vazio.
  assert.deepEqual({ ...itens[2].promotor, cnpj: itens[2].loja.cnpj }, { nome: 'AKTO', tipo: 'AGENCIA', agencia: 'AKTO', codigo: '', cnpj: '' });
  assert.deepEqual(itens[3].promotor, { nome: 'MARIA', tipo: 'CLT', agencia: 'Filial PR (CLT)', codigo: '30' });
  assert.equal(itens[3].custo, null); // CLT: sem valor por loja (o custo é o salário)
  assert.notEqual(itens[3].loja.chave, itens[4].loja.chave); // "Condor" de Curitiba e "Condor" da Lapa são lojas diferentes
  assert.equal(itens[5].promotor.tipo, 'FREELANCER');
  assert.deepEqual(avisos, {
    'Loja com CNPJ errado (entrou sem CNPJ)': 1,
    'Loja sem CNPJ': 3,
    'Linha sem valor (usa o custo fixo do cadastro do promotor, se houver)': 2,
  });
});

test('cadastro de promotores: reconhece as colunas e trata texto no lugar de valor', () => {
  const titulos = ['', 'Empresa / grupo', 'Admissão', 'Código', 'Nome', 'Salário (R$)', 'Periculosidade 30%', 'Ajuda celular fixo', 'Ajuda de custo / alimentação / almoço', 'Vale transporte', 'Região', 'Gratificação'];
  const mapa = sugerirMapa(titulos, 'promotores');
  assert.deepEqual(mapa, { empresa: 1, admissao: 2, codigo: 3, nome: 4, salario: 5, periculosidade: 6, ajuda_celular: 7, ajuda_custo: 8, vale_transporte: 9, regiao: 10, gratificacao: 11 });
  const agrupador = criarAgrupador('promotores', mapa, {});
  [
    ['', 'EMPRESA X', '27/01/2025', '30389', 'Fulana de Tal', 2390, 717, 50, 600, 400, 'Joinville', ''],
    ['', 'EMPRESA X', '01/09/2026', '30566', 'Beltrano Silva', 3700, 'CARRO', 'supervisor', '600 + 120m', 400, 'São José', 150.5],
    titulos, // o cadastro repete o cabeçalho a cada grupo de empresa
    ['', '', '', '', '', '', '', '', '', '', '', ''],
  ].forEach(agrupador.adicionar);
  const { itens, avisos, motivos } = agrupador.resultado();
  assert.equal(itens.length, 2);
  assert.deepEqual({ tipo: itens[0].tipo, admissao: itens[0].admissao, salario: itens[0].salario, periculosidade: itens[0].periculosidade, observacao: itens[0].observacao },
    { tipo: 'CLT', admissao: '2025-01-27', salario: 2390, periculosidade: 717, observacao: '' });
  // "CARRO" vira 0, "600 + 120m" vira 600, e o texto original fica na observação para conferir.
  assert.deepEqual([itens[1].periculosidade, itens[1].ajuda_celular, itens[1].ajuda_custo, itens[1].gratificacao], [0, 0, 600, 150.5]);
  assert.match(itens[1].observacao, /periculosidade: "CARRO".*ajuda celular: "supervisor".*ajuda custo: "600 \+ 120m"/);
  assert.deepEqual(avisos, { 'Promotor com texto no lugar de valor (veja a observação no cadastro)': 1 });
  assert.deepEqual(motivos, { 'Linha de cabeçalho repetida': 1, 'Linha sem nome': 1 });
});

test('cargo grudado no nome, supervisor e código do promotor', () => {
  const { separarCargo, ehSupervisor, codigoNormal } = require('../src/planilha');
  assert.deepEqual(separarCargo('SARA ADRIANA DIAS SOUTO - Sup ll'), { nome: 'SARA ADRIANA DIAS SOUTO', cargo: 'Sup ll' });
  assert.deepEqual(separarCargo('Alessandra Cipriano Pamplona - Sup.'), { nome: 'Alessandra Cipriano Pamplona', cargo: 'Sup.' });
  assert.deepEqual(separarCargo('MARCUS YURI DO CARMO PEREIRA - Lider'), { nome: 'MARCUS YURI DO CARMO PEREIRA', cargo: 'Lider' });
  // Nomes de agência com parênteses ou números ficam inteiros.
  assert.equal(separarCargo('101 do Brasil - Filial PR (CLT)').cargo, '');
  assert.equal(separarCargo('MEI PR - Joseane (68.481.098/0001-80)').cargo, '');
  assert.equal(separarCargo('Maria').cargo, '');
  assert.deepEqual(['Sup.', 'Sup ll', 'Sup. l', 'supervisor', 'Supervisora'].map(ehSupervisor), [true, true, true, true, true]);
  assert.deepEqual(['Lider', 'INSS', 'Lic. Maternidade', '', 'Suporte'].map(ehSupervisor), [false, false, false, false, false]);
  assert.equal(codigoNormal('06'), codigoNormal(6));
  assert.equal(codigoNormal(' 0030389 '), '30389');
  assert.equal(codigoNormal('0'), '0');
});

test('cadastro: o agrupador separa o cargo do nome', () => {
  const agrupador = criarAgrupador('promotores', { nome: 0, codigo: 1, salario: 2 }, {});
  agrupador.adicionar(['Lionis Valter Garcez - Sup. ll', '30001', 3000]);
  const [item] = agrupador.resultado().itens;
  assert.deepEqual([item.nome, item.cargo, item.codigo], ['Lionis Valter Garcez', 'Sup. ll', '30001']);
});

test('acha pessoa pelo nome: completo, ou primeiro nome só se for único', () => {
  const { acharPorNome } = require('../src/planilha');
  const lista = [{ nome: 'JESUS ANGELS ZAPATA RIVAS' }, { nome: 'Maria Lima' }, { nome: 'Maria Souza' }, { nome: 'José Pereira' }];
  assert.equal(acharPorNome('Jesus', lista).nome, 'JESUS ANGELS ZAPATA RIVAS');
  assert.equal(acharPorNome('jesús angels zapata rivas', lista).nome, 'JESUS ANGELS ZAPATA RIVAS');
  assert.equal(acharPorNome('JOSE PEREIRA', lista).nome, 'José Pereira');
  assert.equal(acharPorNome('Maria', lista), null); // duas Marias: não adivinha
  assert.equal(acharPorNome('John Duarte', lista), null);
  assert.equal(acharPorNome('', lista), null);
});
