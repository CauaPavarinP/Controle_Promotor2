// Planilhas no servidor: converter .xlsx em linhas e montar arquivos .xlsx (exportações e modelos).
// A interpretação das linhas (colunas, valores, somas) fica em public/js/planilha-comum.js,
// que é o mesmo código usado pelo navegador na tela Importar.
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const comum = require('../public/js/planilha-comum');

// O ExcelJS devolve alguns valores como objeto (fórmula, texto formatado, link, data). Aqui vira valor simples.
function valorSimples(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10).split('-').reverse().join('/'); // 31/10/2026
  if (typeof v === 'object') {
    if (v.result !== undefined) return valorSimples(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return valorSimples(v.text);
    return '';
  }
  return typeof v === 'string' ? v.trim() : v;
}

// O ExcelJS quebra ao abrir planilhas com comentários (aquelas notas amarelas nas células) gravados por
// alguns programas. Como os comentários não nos interessam, tiramos a ligação para eles antes de abrir.
// Um .xlsx é um arquivo .zip com vários .xml dentro; a ligação fica nos arquivos "_rels" de cada aba.
async function semComentarios(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let mudou = false;
  for (const nome of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/_rels\/.*\.rels$/.test(nome)) continue;
    const xml = await zip.file(nome).async('string');
    const limpo = xml.replace(/<Relationship\b[^>]*\/relationships\/(comments|vmlDrawing)"[^>]*\/>/g, '');
    if (limpo !== xml) { zip.file(nome, limpo); mudou = true; }
  }
  return mudou ? zip.generateAsync({ type: 'nodebuffer' }) : buffer;
}

// Lê um .xlsx e devolve as abas: [{ nome, linhas: [[celula, celula...], ...] }]
async function lerXlsx(buffer) {
  const pasta = new ExcelJS.Workbook();
  try {
    await pasta.xlsx.load(await semComentarios(buffer));
  } catch {
    throw new Error('Não consegui abrir o arquivo. Envie uma planilha .xlsx, .csv ou o .xls do FoccoERP.');
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

module.exports = { ...comum, lerXlsx, montarPlanilha };
