// Leitura e interpretação de planilhas. ESTE ARQUIVO RODA EM DOIS LUGARES:
//  - no navegador (tela Importar), onde fica disponível como "Planilha";
//  - no servidor (Node.js), via require, para os testes e para conferir os dados recebidos.
// Por isso ele não usa nada específico de navegador nem de Node.
//
// Por que ler no navegador? O relatório do FoccoERP pode passar de 150 MB. Em vez de enviar tudo
// para o servidor, o navegador lê o arquivo aos poucos, soma por loja e mês, e envia só o resultado.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Planilha = fabrica();
})(typeof self !== 'undefined' ? self : this, () => {
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

  // ---------- Reconhecimento das colunas ----------

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

  // Analisa as primeiras linhas para a tela de conferência: acha o cabeçalho (entre as 30 primeiras
  // linhas, a que tem mais colunas reconhecidas), sugere as colunas e separa uma amostra.
  function analisar(linhas, tipo) {
    let linhaCabecalho = 0;
    let acertos = -1;
    linhas.slice(0, 30).forEach((linha, indice) => {
      const n = Object.keys(sugerirMapa(linha, tipo)).length;
      if (n > acertos) { acertos = n; linhaCabecalho = indice; }
    });
    const colunas = (linhas[linhaCabecalho] || []).map(textoDe);
    return {
      linhaCabecalho,
      colunas,
      mapa: sugerirMapa(colunas, tipo),
      campos: CAMPOS[tipo].map(({ campo, rotulo }) => ({ campo, rotulo })),
      amostra: linhas.slice(linhaCabecalho + 1, linhaCabecalho + 6).map((l) => l.map(textoDe)),
    };
  }

  // ---------- Conversões de valores ----------

  function textoDe(v) {
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
    return digitos.length >= 11 && digitos.length <= 14 ? digitos : '';
  }

  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function montarMes(ano, mes) {
    ano = Number(ano); mes = Number(mes);
    if (ano < 100) ano += 2000;
    if (!(mes >= 1 && mes <= 12) || !(ano >= 2000 && ano <= 2100)) return null;
    return `${ano}-${String(mes).padStart(2, '0')}`;
  }

  // Converte data ou mês em "AAAA-MM". Aceita: 15/10/2026, 10/2026, 2026-10, 2026-10-15, out/26, outubro de 2026.
  function mesDe(v) {
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

  // ---------- Leitura do arquivo aos poucos ----------

  const ENTIDADES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  // Tira as marcações de um trecho de HTML e devolve só o texto.
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

  function celulasHtml(trecho) {
    return [...trecho.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/t[dh]>|$)/gi)].map((c) => textoDoHtml(c[1]));
  }

  function celulasCsv(linha, separador) {
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
  }

  // Leitor que recebe o arquivo em pedaços de texto e devolve as linhas completas de cada pedaço.
  // formato "html": o .xls do FoccoERP (por dentro é uma tabela HTML). formato "csv": texto separado por ; ou ,
  // Uso: const leitor = criarLeitor('html'); leitor.receber(pedaco) -> linhas; no final, leitor.terminar() -> linhas.
  function criarLeitor(formato) {
    let resto = ''; // pedaço que ainda não formou uma linha completa
    let separador = null;

    function linhasHtml(fim) {
      const linhas = [];
      const marca = /<tr\b|<\/table/gi;
      let aberta = -1; // posição do <tr> que ainda não fechou
      let achado;
      while ((achado = marca.exec(resto))) {
        if (aberta >= 0) linhas.push(celulasHtml(resto.slice(aberta, achado.index)));
        aberta = achado[0].toLowerCase() === '<tr' ? achado.index : -1;
      }
      if (fim) {
        if (aberta >= 0) linhas.push(celulasHtml(resto.slice(aberta)));
        resto = '';
      } else {
        // Guarda a linha que ficou pela metade (ou o finalzinho, caso um "<tr" tenha sido cortado ao meio).
        resto = aberta >= 0 ? resto.slice(aberta) : resto.slice(-10);
      }
      return linhas.filter((linha) => linha.some((celula) => celula !== ''));
    }

    function linhasCsv(fim) {
      const partes = resto.split('\n');
      resto = fim ? '' : partes.pop();
      const linhas = [];
      for (let texto of partes) {
        texto = texto.replace(/^﻿/, '').replace(/\r$/, '');
        if (!texto.trim()) continue;
        if (!separador) separador = (texto.match(/;/g) || []).length >= (texto.match(/,/g) || []).length ? ';' : ',';
        linhas.push(celulasCsv(texto, separador));
      }
      return linhas;
    }

    const extrair = formato === 'html' ? linhasHtml : linhasCsv;
    return {
      receber(texto) { resto += texto; return extrair(false); },
      terminar() { return extrair(true); },
    };
  }

  // Lê um texto inteiro de uma vez (arquivos pequenos e testes).
  function lerTexto(texto, formato) {
    const leitor = criarLeitor(formato);
    return [...leitor.receber(texto), ...leitor.terminar()];
  }

  // ---------- Agrupamento: linhas do arquivo -> itens para gravar ----------

  function tipoDe(texto, padrao) {
    const t = normalizar(texto);
    if (t.includes('clt')) return 'CLT';
    if (t.includes('mei')) return 'MEI';
    if (t.includes('agenc')) return 'AGENCIA';
    return padrao;
  }

  // Recebe as linhas de dados uma a uma e vai somando.
  //  - faturamento: um item por loja + mês + empresa, com a soma do valor;
  //  - visitas: um item por promotor + loja + mês, com a soma das visitas e do custo.
  // "mapa" diz em qual coluna está cada campo. "opcoes" traz o que não está no arquivo (mês, empresa, promotor).
  function criarAgrupador(tipo, mapa, opcoes = {}) {
    const tem = (campo) => Number.isInteger(mapa[campo]);
    if (!tem('cnpj') && !tem('loja')) throw new Error('Indique a coluna do CNPJ ou do nome da loja.');
    if (tipo === 'faturamento' && !tem('valor')) throw new Error('Indique qual coluna tem o valor faturado.');
    if (opcoes.mes && !mesValido(opcoes.mes)) throw new Error('Mês inválido.');

    const pegar = (linha, campo) => (tem(campo) ? linha[mapa[campo]] ?? '' : '');
    const somas = new Map();
    const motivos = {}; // por que linhas foram ignoradas, e quantas
    const ignorar = (motivo) => { motivos[motivo] = (motivos[motivo] || 0) + 1; };
    const novo = opcoes.promotorNovo || {};
    const tipoPadrao = ['CLT', 'MEI', 'AGENCIA'].includes(novo.tipo) ? novo.tipo : 'AGENCIA';
    const empresaPadrao = textoDe(opcoes.empresa);

    function lojaDaLinha(linha) {
      const cnpj = cnpjDe(pegar(linha, 'cnpj'));
      const nome = textoDe(pegar(linha, 'loja'));
      if (!cnpj && (!nome || /^(sub)?total/i.test(nome))) return null;
      return {
        chave: cnpj || `nome:${normalizar(nome)}`,
        cnpj,
        nome: nome || `CNPJ ${cnpj}`,
        cidade: textoDe(pegar(linha, 'cidade')),
        uf: textoDe(pegar(linha, 'uf')),
        endereco: textoDe(pegar(linha, 'endereco')),
      };
    }

    function adicionarFaturamento(linha) {
      const loja = lojaDaLinha(linha);
      if (!loja) return ignorar('Sem loja (linha de total ou em branco)');
      const valor = numeroDe(pegar(linha, 'valor'));
      if (valor === null) return ignorar('Valor não é número');
      const mes = mesDe(pegar(linha, 'data')) || opcoes.mes;
      if (!mes) return ignorar('Sem data/mês (informe o mês na tela)');
      const empresa = textoDe(pegar(linha, 'empresa')) || empresaPadrao;
      const chave = `${loja.chave}|${mes}|${empresa.toLowerCase()}`;
      if (!somas.has(chave)) somas.set(chave, { loja, mes, empresa, valor: 0 });
      somas.get(chave).valor += valor;
    }

    function adicionarVisita(linha) {
      const loja = lojaDaLinha(linha);
      if (!loja) return ignorar('Sem loja (linha de total ou em branco)');
      const mes = mesDe(pegar(linha, 'data')) || opcoes.mes;
      if (!mes) return ignorar('Sem mês (informe o mês na tela)');
      // O promotor vem da coluna "Promotor"; se o arquivo não tiver (caso das agências), vale o escolhido na tela.
      const nomeNaLinha = textoDe(pegar(linha, 'promotor'));
      let promotor;
      if (nomeNaLinha) {
        promotor = { nome: nomeNaLinha, tipo: tipoDe(pegar(linha, 'tipo'), tipoPadrao), agencia: textoDe(pegar(linha, 'agencia')) || textoDe(novo.agencia) };
      } else if (opcoes.promotorId) promotor = { id: Number(opcoes.promotorId) };
      else if (textoDe(novo.nome)) promotor = { nome: textoDe(novo.nome), tipo: tipoPadrao, agencia: textoDe(novo.agencia) };
      else return ignorar('Sem promotor (escolha o promotor na tela)');
      const chavePromotor = promotor.id ? `id:${promotor.id}` : `nome:${promotor.nome.toLowerCase()}`;
      const visitas = Math.max(0, Math.round(numeroDe(pegar(linha, 'visitas')) || 0));
      const custo = numeroDe(pegar(linha, 'custo'));
      const chave = `${chavePromotor}|${loja.chave}|${mes}`;
      if (!somas.has(chave)) somas.set(chave, { promotor, loja, mes, visitas: 0, custo: null });
      const item = somas.get(chave);
      item.visitas += visitas;
      if (custo !== null) item.custo = (item.custo || 0) + custo;
    }

    return {
      adicionar: tipo === 'faturamento' ? adicionarFaturamento : adicionarVisita,
      resultado() {
        const arredondar = (v) => (v === null ? null : Math.round(v * 100) / 100);
        const itens = [...somas.values()].map((item) => (tipo === 'faturamento'
          ? { ...item, valor: arredondar(item.valor) }
          : { ...item, custo: arredondar(item.custo) }));
        return { itens, motivos };
      },
    };
  }

  return { CAMPOS, normalizar, sugerirMapa, analisar, textoDe, numeroDe, cnpjDe, mesDe, mesValido, textoDoHtml, criarLeitor, lerTexto, criarAgrupador };
});
