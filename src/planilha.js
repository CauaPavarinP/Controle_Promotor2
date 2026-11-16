// Leitura de planilhas (.xlsx e .csv) e "tradução" das colunas.
// Cada agência manda o arquivo de um jeito, então o sistema tenta adivinhar qual coluna é qual
// pelo nome do cabeçalho, e a pessoa confere/corrige na tela antes de importar.
const ExcelJS = require('exceljs');

// Tira acentos, deixa minúsculo e troca pontuação por espaço: "Estab. CNPJ" -> "estab cnpj".
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Campos que cada tipo de importação conhece, com os nomes de coluna mais comuns (em ordem de preferência).
const CAMPOS = {
  faturamento: [
    { campo: 'cnpj', rotulo: 'CNPJ da loja', nomes: ['cnpj', 'cpf cnpj', 'cnpj cpf', 'cgc'] },
    { campo: 'loja', rotulo: 'Nome da loja / cliente', nomes: ['razao social', 'cliente', 'nome cliente', 'nome fantasia', 'fantasia', 'loja', 'estabelecimento', 'nome'] },
    { campo: 'valor', rotulo: 'Valor faturado', nomes: ['valor faturado', 'faturamento', 'valor total', 'vlr total', 'total', 'valor liquido', 'valor', 'vlr'] },
    { campo: 'data', rotulo: 'Data ou mês', nomes: ['data emissao', 'dt emissao', 'dt emis', 'emissao', 'data', 'mes', 'competencia', 'periodo'] },
    { campo: 'empresa', rotulo: 'Empresa', nomes: ['empresa', 'cod emp', 'filial'] },
    { campo: 'cidade', rotulo: 'Cidade', nomes: ['cidade', 'municipio'] },
    { campo: 'uf', rotulo: 'UF', nomes: ['uf', 'estado'] },
  ],
  visitas: [
    { campo: 'cnpj', rotulo: 'CNPJ da loja', nomes: ['cnpj', 'cpf cnpj', 'cgc'] },
    { campo: 'loja', rotulo: 'Nome da loja / mercado', nomes: ['loja', 'estabelecimento', 'mercado', 'pdv', 'ponto de venda', 'razao social', 'nome fantasia', 'cliente'] },
    { campo: 'visitas', rotulo: 'Quantidade de visitas no mês', nomes: ['visitas', 'qtd visitas', 'vis mes', 'visitas mes', 'qtde visitas', 'qtd', 'vis'] },
    { campo: 'custo', rotulo: 'Custo no mês (R$)', nomes: ['custo', 'vlr mes', 'valor mes', 'custo mes', 'valor total', 'valor', 'vlr'] },
    { campo: 'promotor', rotulo: 'Promotor', nomes: ['promotor', 'promotora', 'nome promotor', 'colaborador'] },
    { campo: 'tipo', rotulo: 'Tipo (CLT, MEI ou Agência)', nomes: ['tipo', 'vinculo', 'contrato'] },
    { campo: 'agencia', rotulo: 'Agência', nomes: ['agencia'] },
    { campo: 'data', rotulo: 'Mês', nomes: ['mes', 'competencia', 'periodo', 'data'] },
    { campo: 'cidade', rotulo: 'Cidade', nomes: ['cidade', 'municipio'] },
    { campo: 'uf', rotulo: 'UF', nomes: ['uf', 'estado'] },
    { campo: 'endereco', rotulo: 'Endereço', nomes: ['endereco', 'logradouro'] },
  ],
};

// O ExcelJS devolve alguns valores como objeto (fórmula, texto formatado, link). Aqui vira valor simples.
function valorSimples(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return valorSimples(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return valorSimples(v.text);
    if (v.error) return '';
    return '';
  }
  return typeof v === 'string' ? v.trim() : v;
}

function lerCsv(texto) {
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!linhas.length) return [];
  const separador = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';
  return linhas.map((linha) => {
    const celulas = [];
    let atual = '';
    let aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (c === '"') {
        if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas;
      } else if (c === separador && !aspas) { celulas.push(atual.trim()); atual = ''; } else atual += c;
    }
    celulas.push(atual.trim());
    return celulas;
  });
}

// O FoccoERP exporta um arquivo ".xls" que, por dentro, é uma página HTML com uma tabela.
// Aqui pegamos cada linha (<tr>) e cada célula (<td>) dessa tabela, tirando as marcações.
const ENTIDADES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function textoDoHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (tudo, codigo) => {
      if (codigo[0] !== '#') return ENTIDADES[codigo.toLowerCase()] ?? tudo;
      const numero = codigo[1].toLowerCase() === 'x' ? parseInt(codigo.slice(2), 16) : Number(codigo.slice(1));
      return Number.isFinite(numero) && numero <= 0x10ffff ? String.fromCodePoint(numero) : tudo;
    })
    .replace(/\s+/g, ' ').trim();
}

function lerHtml(texto) {
  const linhas = [];
  for (const [, linha] of texto.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tr>|<\/table>)/gi)) {
    const celulas = [...linha.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/t[dh]>|$)/gi)].map((c) => textoDoHtml(c[1]));
    if (celulas.some((c) => c !== '')) linhas.push(celulas);
  }
  return linhas;
}

// Converte os bytes em texto. Arquivos antigos do Windows (como os do Focco) não usam UTF-8.
function decodificar(buffer) {
  const texto = buffer.toString('utf8');
  return texto.includes('\uFFFD') ? buffer.toString('latin1') : texto;
}

// Lê o arquivo e devolve as abas: [{ nome, linhas: [[celula, celula...], ...] }]
async function lerArquivo(buffer, nomeArquivo = '') {
  const nome = nomeArquivo.toLowerCase();
  // Olhamos o começo do conteúdo, e não só a extensão, porque o ".xls" do Focco na verdade é HTML.
  const comeco = buffer.subarray(0, 2000).toString('latin1').toLowerCase();
  if (/<html|<table|<!doctype/.test(comeco)) {
    const linhas = lerHtml(decodificar(buffer));
    if (!linhas.length) throw new Error('Não encontrei nenhuma tabela dentro do arquivo.');
    return [{ nome: 'Relatório', linhas }];
  }
  if (nome.endsWith('.csv') || nome.endsWith('.txt')) {
    return [{ nome: 'CSV', linhas: lerCsv(decodificar(buffer)) }];
  }
  if (nome.endsWith('.xls')) {
    throw new Error('Este .xls é do Excel antigo (binário) e não é aceito. Abra no Excel e use "Salvar como" → .xlsx.');
  }
  const pasta = new ExcelJS.Workbook();
  try {
    await pasta.xlsx.load(buffer);
  } catch {
    throw new Error('Não consegui abrir o arquivo. Envie uma planilha .xlsx ou .csv.');
  }
  const abas = [];
  pasta.eachSheet((aba) => {
    const linhas = [];
    aba.eachRow({ includeEmpty: false }, (linha) => {
      const valores = [];
      for (let c = 1; c <= linha.cellCount; c++) valores.push(valorSimples(linha.getCell(c).value));
      if (valores.some((v) => v !== '')) linhas.push(valores);
    });
    if (linhas.length) abas.push({ nome: aba.name, linhas });
  });
  if (!abas.length) throw new Error('A planilha está vazia.');
  return abas;
}

// Sugere qual coluna corresponde a cada campo. Devolve { campo: índiceDaColuna }.
function sugerirMapa(cabecalho, tipo) {
  const colunas = cabecalho.map(normalizar);
  const usadas = new Set();
  const mapa = {};
  const procurar = (teste) => colunas.findIndex((coluna, i) => !usadas.has(i) && coluna && teste(coluna));
  // 1ª passada: nome idêntico. 2ª passada: o nome aparece dentro do cabeçalho ("estab cnpj" contém "cnpj").
  for (const exato of [true, false]) {
    for (const { campo, nomes } of CAMPOS[tipo]) {
      if (mapa[campo] !== undefined) continue;
      for (const nome of nomes) {
        const i = procurar((coluna) => (exato ? coluna === nome : ` ${coluna} `.includes(` ${nome} `)));
        if (i >= 0) { mapa[campo] = i; usadas.add(i); break; }
      }
    }
  }
  return mapa;
}

// Acha a linha do cabeçalho: entre as 30 primeiras, a que tem mais colunas reconhecidas.
function acharCabecalho(linhas, tipo) {
  let melhor = { indice: 0, acertos: -1 };
  linhas.slice(0, 30).forEach((linha, indice) => {
    const acertos = Object.keys(sugerirMapa(linha, tipo)).length;
    if (acertos > melhor.acertos) melhor = { indice, acertos };
  });
  return melhor.indice;
}

// Analisa o arquivo para a tela de conferência (não grava nada).
function analisar(abas, tipo, nomeAba) {
  const aba = abas.find((a) => a.nome === nomeAba) || abas[0];
  const indice = acharCabecalho(aba.linhas, tipo);
  const cabecalho = aba.linhas[indice].map((c) => textoDe(c));
  return {
    abas: abas.map((a) => a.nome),
    aba: aba.nome,
    linhaCabecalho: indice,
    colunas: cabecalho,
    mapa: sugerirMapa(cabecalho, tipo),
    campos: CAMPOS[tipo].map(({ campo, rotulo }) => ({ campo, rotulo })),
    amostra: aba.linhas.slice(indice + 1, indice + 6).map((l) => l.map(textoDe)),
    totalLinhas: aba.linhas.length - indice - 1,
  };
}

// ---------- Conversões de valores ----------

function textoDe(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10).split('-').reverse().join('/');
  return String(v ?? '').trim();
}

// "R$ 1.234,56" -> 1234.56 | 127.12 -> 127.12 | texto que não é número -> null
function numeroDe(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let texto = String(v ?? '').replace(/[R$\s]/g, '');
  if (!texto) return null;
  if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : null;
}

// Só os dígitos do CNPJ. O Excel "come" os zeros da esquerda quando a coluna é número, então completamos.
function cnpjDe(v) {
  let digitos = typeof v === 'number' ? String(Math.round(v)) : String(v ?? '').replace(/\D/g, '');
  if (digitos.length >= 12 && digitos.length < 14) digitos = digitos.padStart(14, '0');
  return digitos.length >= 11 ? digitos : '';
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function montarMes(ano, mes) {
  ano = Number(ano); mes = Number(mes);
  if (ano < 100) ano += 2000;
  if (!(mes >= 1 && mes <= 12) || !(ano >= 2000 && ano <= 2100)) return null;
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

// Converte data ou mês em "AAAA-MM". Aceita: data do Excel, 15/10/2026, 10/2026, 2026-10, out/26, outubro 2026.
function mesDe(v) {
  if (v instanceof Date) return montarMes(v.getUTCFullYear(), v.getUTCMonth() + 1);
  const texto = String(v ?? '').trim().toLowerCase();
  let m;
  if ((m = texto.match(/^(\d{4})-(\d{1,2})(-\d{1,2})?/))) return montarMes(m[1], m[2]);
  if ((m = texto.match(/^\d{1,2}[/.-](\d{1,2})[/.-](\d{2,4})/))) return montarMes(m[2], m[1]);
  if ((m = texto.match(/^(\d{1,2})[/.-](\d{2,4})$/))) return montarMes(m[2], m[1]);
  if ((m = normalizar(texto).match(/^([a-z]{3})[a-z]*\s*(?:de\s*)?(\d{2,4})$/))) {
    const indice = MESES.indexOf(m[1]);
    if (indice >= 0) return montarMes(m[2], indice + 1);
  }
  return null;
}

function mesValido(texto) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(texto || ''));
}

// Monta uma planilha .xlsx simples (usada nas exportações e nos modelos).
async function montarPlanilha(nomeAba, colunas, linhas) {
  const pasta = new ExcelJS.Workbook();
  const aba = pasta.addWorksheet(nomeAba);
  aba.columns = colunas.map((c) => ({ header: c.titulo, key: c.chave, width: c.largura || 18, style: c.formato ? { numFmt: c.formato } : {} }));
  aba.getRow(1).font = { bold: true };
  aba.views = [{ state: 'frozen', ySplit: 1 }];
  for (const linha of linhas) aba.addRow(linha);
  return Buffer.from(await pasta.xlsx.writeBuffer());
}

module.exports = { lerArquivo, analisar, sugerirMapa, normalizar, textoDe, numeroDe, cnpjDe, mesDe, mesValido, montarPlanilha, CAMPOS };
