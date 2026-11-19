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
    // Aba "Atendimentos" do modelo padrão (uma linha por loja atendida no mês).
    visitas: [
      { campo: 'cnpj', rotulo: 'CNPJ da loja', nomes: ['cnpj da loja', 'cnpj', 'cpf cnpj', 'cgc'] },
      { campo: 'loja', rotulo: 'Nome da loja / mercado', nomes: ['loja', 'estabelecimento', 'mercado', 'pdv', 'ponto de venda', 'razao social', 'nome fantasia', 'cliente'] },
      { campo: 'visitas', rotulo: 'Quantidade de visitas no mês', nomes: ['visitas no mes', 'visitas', 'qtd visitas', 'vis mes', 'visitas mes', 'qtde visitas', 'qtd', 'vis'] },
      { campo: 'custo', rotulo: 'Valor / custo no mês (R$)', nomes: ['valor do mes r', 'valor do mes', 'custo', 'vlr mes', 'valor mes', 'custo mes', 'valor total', 'valor', 'vlr'] },
      { campo: 'promotor', rotulo: 'Promotor', nomes: ['promotor', 'promotora', 'nome promotor', 'colaborador'] },
      { campo: 'codigo', rotulo: 'Código do promotor', nomes: ['codigo do promotor', 'codigo promotor', 'matricula', 'codigo'] },
      { campo: 'tipo', rotulo: 'Tipo (Agência, CLT, MEI, Freelancer)', nomes: ['tipo', 'vinculo', 'contrato'] },
      { campo: 'agencia', rotulo: 'Agência ou MEI', nomes: ['agencia ou mei', 'agencia'] },
      { campo: 'data', rotulo: 'Mês de referência', nomes: ['mes de referencia', 'mes', 'competencia', 'periodo', 'data'] },
      { campo: 'dias', rotulo: 'Dias de visita', nomes: ['dias de visita', 'dias', 'frequencia'] },
      { campo: 'status', rotulo: 'Status', nomes: ['status', 'situacao'] },
      { campo: 'supervisor', rotulo: 'Supervisor', nomes: ['supervisor', 'supervisora'] },
      { campo: 'observacao', rotulo: 'Observação', nomes: ['observacao', 'obs'] },
      { campo: 'cidade', rotulo: 'Cidade', nomes: ['cidade', 'municipio'] },
      { campo: 'uf', rotulo: 'UF', nomes: ['uf', 'estado'] },
      { campo: 'endereco', rotulo: 'Endereço', nomes: ['endereco', 'logradouro'] },
    ],
    // Cadastro de promotores com os custos mensais (aba "Promotores CLT" do modelo padrão).
    promotores: [
      { campo: 'nome', rotulo: 'Nome do promotor', nomes: ['nome', 'promotor', 'colaborador', 'funcionario'] },
      { campo: 'codigo', rotulo: 'Código / matrícula', nomes: ['codigo', 'matricula', 'codigo do promotor'] },
      { campo: 'cargo', rotulo: 'Cargo (se vier separado do nome)', nomes: ['cargo', 'funcao'] },
      { campo: 'empresa', rotulo: 'Empresa / grupo', nomes: ['empresa grupo', 'empresa', 'grupo'] },
      { campo: 'admissao', rotulo: 'Admissão', nomes: ['admissao', 'data admissao', 'data de admissao'] },
      { campo: 'salario', rotulo: 'Salário', nomes: ['salario r', 'salario'] },
      { campo: 'periculosidade', rotulo: 'Periculosidade', nomes: ['periculosidade 30', 'periculosidade'] },
      { campo: 'ajuda_celular', rotulo: 'Ajuda celular', nomes: ['ajuda celular fixo', 'ajuda celular', 'celular'] },
      { campo: 'ajuda_custo', rotulo: 'Ajuda de custo / alimentação', nomes: ['ajuda de custo alimentacao almoco', 'ajuda de custo', 'alimentacao'] },
      { campo: 'almoco', rotulo: 'Almoço (se vier separado)', nomes: ['almoco', 'refeicao'] },
      { campo: 'vale_transporte', rotulo: 'Vale-transporte', nomes: ['vale transporte', 'vt'] },
      { campo: 'gratificacao', rotulo: 'Gratificação', nomes: ['gratificacao'] },
      { campo: 'outros_custos', rotulo: 'Outros custos', nomes: ['outros custos', 'outros'] },
      { campo: 'regiao', rotulo: 'Região', nomes: ['regiao', 'cidade'] },
      { campo: 'tipo', rotulo: 'Tipo (CLT, MEI...)', nomes: ['tipo', 'vinculo'] },
      { campo: 'agencia', rotulo: 'Agência', nomes: ['agencia ou mei', 'agencia'] },
      { campo: 'telefone', rotulo: 'Telefone', nomes: ['telefone', 'celular whatsapp', 'whatsapp'] },
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
      acertos, // quantas colunas foram reconhecidas (serve para escolher a aba certa da planilha)
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

  // Confere os dois dígitos verificadores do CNPJ (pega número digitado errado).
  // UF por extenso ou sigla -> sigla ("São Paulo" -> "SP", "sp" -> "SP"). Desconhecida -> ''.
  const UFS = {
    AC: 'acre', AL: 'alagoas', AP: 'amapa', AM: 'amazonas', BA: 'bahia', CE: 'ceara', DF: 'distrito federal',
    ES: 'espirito santo', GO: 'goias', MA: 'maranhao', MT: 'mato grosso', MS: 'mato grosso do sul', MG: 'minas gerais',
    PA: 'para', PB: 'paraiba', PR: 'parana', PE: 'pernambuco', PI: 'piaui', RJ: 'rio de janeiro', RN: 'rio grande do norte',
    RS: 'rio grande do sul', RO: 'rondonia', RR: 'roraima', SC: 'santa catarina', SP: 'sao paulo', SE: 'sergipe', TO: 'tocantins',
  };
  function ufDe(texto) {
    const t = normalizar(texto);
    if (!t) return '';
    const sigla = t.toUpperCase();
    if (UFS[sigla]) return sigla;
    return Object.keys(UFS).find((uf) => UFS[uf] === t) || '';
  }

  // Identidade de uma loja atendida: CNPJ + nome + cidade. Duas lojas de uma rede podem usar o mesmo CNPJ
  // (a matriz ou o CD compra por elas); por isso o CNPJ sozinho não identifica a loja.
  const chaveDaLoja = (cnpj, nome, cidade) => `${cnpj || ''}|${normalizar(nome)}|${normalizar(cidade)}`;

  function cnpjValido(cnpj) {
    if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
    const digito = (tamanho) => {
      let soma = 0;
      let peso = tamanho - 7;
      for (let i = 0; i < tamanho; i++) {
        soma += Number(cnpj[i]) * peso;
        peso = peso === 2 ? 9 : peso - 1;
      }
      const resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    return digito(12) === Number(cnpj[12]) && digito(13) === Number(cnpj[13]);
  }

  // "27/01/2025" ou "2025-01-27" -> "2025-01-27". Qualquer outra coisa -> ''.
  function dataDe(v) {
    const texto = String(v ?? '').trim();
    let m;
    if ((m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if ((m = texto.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[0];
    return '';
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

  const TIPOS_VALIDOS = ['CLT', 'MEI', 'AGENCIA', 'FREELANCER'];
  function tipoDe(texto, padrao) {
    const t = normalizar(texto);
    if (t.includes('clt')) return 'CLT';
    if (t.includes('mei')) return 'MEI';
    if (t.includes('free')) return 'FREELANCER';
    if (t.includes('agenc')) return 'AGENCIA';
    return padrao;
  }

  const primeiroNome = (nome) => normalizar(nome).split(' ')[0] || '';

  // "NOME DA PESSOA - Sup ll" -> { nome: 'NOME DA PESSOA', cargo: 'Sup ll' }.
  // Só separa quando o fim parece um cargo: curto e sem números, parênteses ou barra. Assim nomes de agência
  // como "101 do Brasil - Filial PR (CLT)" ou "MEI PR - Joseane (68.481...)" não são cortados.
  function separarCargo(texto) {
    const t = textoDe(texto);
    const m = t.match(/^(.*\S)\s+-\s+([^\d()/]{2,30})$/);
    if (!m || m[1].trim().length < 3) return { nome: t, cargo: '' };
    return { nome: m[1].trim(), cargo: m[2].trim() };
  }

  // Acha uma pessoa pelo nome, sem acento e sem diferenciar maiúsculas:
  //   1º) nome completo igual;  2º) mesmo primeiro nome, mas SÓ se houver uma pessoa só com ele.
  // Com duas ou mais "Maria", não adivinha: devolve null. (Ex.: "Jesus" na planilha acha "JESUS ANGELS ZAPATA RIVAS".)
  function acharPorNome(nome, lista) {
    const alvo = normalizar(nome);
    if (!alvo) return null;
    const iguais = lista.filter((p) => normalizar(p.nome) === alvo);
    if (iguais.length === 1) return iguais[0];
    if (iguais.length > 1) return null;
    const primeiro = primeiroNome(nome);
    const mesmoPrimeiro = lista.filter((p) => primeiroNome(p.nome) === primeiro);
    return mesmoPrimeiro.length === 1 ? mesmoPrimeiro[0] : null;
  }

  // Divide o texto da coluna "Supervisor": "Jesus, Leo", "Jesus/Leo", "Jesus; Leo" e "Jesus e Leo" são 2 pessoas.
  // O " e " só divide quando o pedaço inteiro NÃO é o nome de um supervisor já conhecido ("chaves", sem acento):
  // assim "Maria Souza e Silva", se cadastrada, continua uma pessoa só. Nomes repetidos ("Jesus, jesús") contam uma vez.
  function separarSupervisores(texto, chaves = new Set()) {
    const nomes = [];
    for (const parte of textoDe(texto).split(/\s*[,;/]\s*/)) {
      if (!parte.trim()) continue;
      const pedacos = chaves.has(normalizar(parte)) ? [parte] : parte.split(/\s+e\s+/i);
      for (const pedaco of pedacos) {
        const nome = pedaco.trim();
        if (nome && !nomes.some((n) => normalizar(n) === normalizar(nome))) nomes.push(nome);
      }
    }
    return nomes;
  }

  // Cargo de supervisor: o cargo (sem acento, minúsculo) começa com "sup" seguido de espaço ou fim
  // ("Sup", "Sup.", "Sup l", "Sup ll") ou com "supervis" ("Supervisor", "Supervisora", "Supervisão").
  // "Suporte", "Lider", "INSS" e "Lic. Maternidade" NÃO são supervisor.
  const ehSupervisor = (cargo) => /^sup( |$)|^supervis/.test(normalizar(cargo));

  // Código do promotor para comparar: "06", "6" e " 6 " são o mesmo código (o Excel às vezes tira o zero).
  const codigoNormal = (codigo) => textoDe(codigo).replace(/\s+/g, '').replace(/^0+(?=.)/, '').toLowerCase();
  const CAMPOS_DINHEIRO = ['salario', 'periculosidade', 'ajuda_celular', 'ajuda_custo', 'almoco', 'vale_transporte', 'gratificacao', 'outros_custos'];

  // Recebe as linhas de dados uma a uma e monta os "itens" que o servidor vai gravar:
  //  - faturamento: um item por loja + mês + empresa, com a soma do valor;
  //  - visitas:     um item por promotor + loja + mês, com a soma das visitas e do custo;
  //  - promotores:  um item por promotor, com os custos mensais do cadastro.
  // "mapa" diz em qual coluna está cada campo. "opcoes" traz o que não está no arquivo (mês, empresa, promotor).
  // O resultado traz também "motivos" (linhas ignoradas) e "avisos" (linhas importadas, mas com algo a conferir).
  function criarAgrupador(tipo, mapa, opcoes = {}) {
    const tem = (campo) => Number.isInteger(mapa[campo]);
    if (tipo === 'promotores') {
      if (!tem('nome')) throw new Error('Indique a coluna com o nome do promotor.');
    } else if (!tem('cnpj') && !tem('loja')) throw new Error('Indique a coluna do CNPJ ou do nome da loja.');
    if (tipo === 'faturamento' && !tem('valor')) throw new Error('Indique qual coluna tem o valor faturado.');
    if (opcoes.mes && !mesValido(opcoes.mes)) throw new Error('Mês inválido.');

    const pegar = (linha, campo) => (tem(campo) ? linha[mapa[campo]] ?? '' : '');
    const somas = new Map();
    const motivos = {}; // por que linhas foram ignoradas, e quantas
    const avisos = {}; // linhas que entraram, mas têm algo para conferir
    const ignorar = (motivo) => { motivos[motivo] = (motivos[motivo] || 0) + 1; };
    const avisar = (aviso) => { avisos[aviso] = (avisos[aviso] || 0) + 1; };
    const novo = opcoes.promotorNovo || {};
    const tipoPadrao = TIPOS_VALIDOS.includes(novo.tipo) ? novo.tipo : (tipo === 'promotores' ? 'CLT' : 'AGENCIA');
    const empresaPadrao = textoDe(opcoes.empresa);

    function lojaDaLinha(linha) {
      const bruto = pegar(linha, 'cnpj');
      let cnpj = cnpjDe(bruto);
      const nome = textoDe(pegar(linha, 'loja'));
      const cidade = textoDe(pegar(linha, 'cidade'));
      if (tipo === 'visitas') {
        // Sem CNPJ certo não dá para ligar a loja ao faturamento do Focco. A linha entra, mas fica o aviso.
        const temAlgo = /\d/.test(String(bruto));
        if (temAlgo && !cnpjValido(cnpj)) { cnpj = ''; if (nome) avisar('Loja com CNPJ errado (entrou sem CNPJ)'); }
        else if (!temAlgo && nome && !/^(sub)?total/i.test(nome)) avisar('Loja sem CNPJ');
      }
      if (!cnpj && (!nome || /^(sub)?total/i.test(nome))) return null;
      return {
        // Faturamento (ERP): o cliente é o CNPJ. Atendimento: a loja é CNPJ + nome + cidade (ver chaveDaLoja).
        chave: tipo === 'faturamento' ? cnpj : chaveDaLoja(cnpj, nome || `CNPJ ${cnpj}`, cidade),
        cnpj,
        nome: nome || `CNPJ ${cnpj}`,
        cidade,
        uf: ufDe(pegar(linha, 'uf')) || textoDe(pegar(linha, 'uf')),
        endereco: textoDe(pegar(linha, 'endereco')),
      };
    }

    // Mês da linha: o da data; sem data, o mês escolhido na tela. Com um mês escolhido na tela, a linha
    // de outro mês fica de fora (FORA). Sem mês na tela ("todos os meses"), vale a data de cada linha.
    const FORA = 'fora';
    function mesDaLinha(linha) {
      const daData = mesDe(pegar(linha, 'data'));
      if (daData && opcoes.mes && daData !== opcoes.mes) return FORA;
      return daData || opcoes.mes || '';
    }

    function adicionarFaturamento(linha) {
      const loja = lojaDaLinha(linha);
      if (!loja) return ignorar('Sem loja (linha de total ou em branco)');
      // O faturamento liga com as lojas atendidas pelo CNPJ: sem ele, não há com o que ligar.
      if (!loja.cnpj) return ignorar('Sem CNPJ (o faturamento liga com as lojas pelo CNPJ)');
      const valor = numeroDe(pegar(linha, 'valor'));
      if (valor === null) return ignorar('Valor não é número');
      const mes = mesDaLinha(linha);
      if (!mes) return ignorar('Sem data/mês (informe o mês na tela)');
      if (mes === FORA) return ignorar(`Fora do mês escolhido (${opcoes.mes})`);
      const empresa = textoDe(pegar(linha, 'empresa')) || empresaPadrao;
      const chave = `${loja.chave}|${mes}|${empresa.toLowerCase()}`;
      if (!somas.has(chave)) somas.set(chave, { loja, mes, empresa, valor: 0 });
      somas.get(chave).valor += valor;
    }

    // Quem atendeu a loja. Ordem: nome na linha; se não tiver, a agência da linha (o "promotor" é a própria
    // agência); se o arquivo não disser nada, o promotor escolhido na tela.
    function promotorDaLinha(linha) {
      const nome = textoDe(pegar(linha, 'promotor'));
      const agencia = textoDe(pegar(linha, 'agencia'));
      const codigo = textoDe(pegar(linha, 'codigo'));
      const tipoPromotor = tipoDe(pegar(linha, 'tipo'), tipoPadrao);
      if (nome || agencia) {
        return { nome: nome || agencia, tipo: tipoPromotor, agencia: agencia || textoDe(novo.agencia), codigo: nome ? codigo : '' };
      }
      if (opcoes.promotorId) return { id: Number(opcoes.promotorId) };
      if (textoDe(novo.nome)) return { nome: textoDe(novo.nome), tipo: tipoPadrao, agencia: textoDe(novo.agencia), codigo: '' };
      return null;
    }

    function adicionarVisita(linha) {
      const loja = lojaDaLinha(linha);
      if (!loja) return ignorar('Sem loja (linha de total ou em branco)');
      const mes = mesDaLinha(linha);
      if (!mes) return ignorar('Sem mês (informe o mês na tela)');
      if (mes === FORA) return ignorar(`Fora do mês escolhido (${opcoes.mes})`);
      const promotor = promotorDaLinha(linha);
      if (!promotor) return ignorar('Sem promotor (escolha o promotor na tela)');
      const chavePromotor = promotor.id ? `id:${promotor.id}`
        : promotor.codigo ? `cod:${promotor.codigo}|${primeiroNome(promotor.nome)}`
          : `nome:${promotor.nome.toLowerCase()}|${promotor.agencia.toLowerCase()}`;
      const visitas = Math.max(0, Math.round(numeroDe(pegar(linha, 'visitas')) || 0));
      const custo = numeroDe(pegar(linha, 'custo'));
      if (custo === null && tem('custo')) avisar('Linha sem valor (usa o custo fixo do cadastro do promotor, se houver)');
      const chave = `${chavePromotor}|${loja.chave}|${mes}`;
      if (!somas.has(chave)) {
        somas.set(chave, { promotor, loja, mes, visitas: 0, custo: null, dias: '', status: '', supervisor: '', observacao: '' });
      } else avisar('Loja repetida para o mesmo promotor no mês (os valores foram somados)');
      const item = somas.get(chave);
      item.visitas += visitas;
      if (custo !== null) item.custo = (item.custo || 0) + custo;
      for (const campo of ['dias', 'status', 'observacao']) item[campo] = item[campo] || textoDe(pegar(linha, campo));
      // Duas linhas do mesmo promotor, loja e mês com supervisores diferentes: guarda os dois ("Jesus, Leo").
      const supervisor = textoDe(pegar(linha, 'supervisor'));
      const jaTem = separarSupervisores(item.supervisor).map(normalizar);
      if (supervisor && !separarSupervisores(supervisor).every((nome) => jaTem.includes(normalizar(nome)))) {
        item.supervisor = item.supervisor ? `${item.supervisor}, ${supervisor}` : supervisor;
      }
    }

    // Valor em dinheiro do cadastro. Algumas células vêm com texto no lugar do número ("carro", "600 + 120m"):
    // usamos o primeiro número que aparecer (ou zero) e guardamos o texto original para a pessoa conferir.
    function dinheiroDe(bruto) {
      const direto = numeroDe(bruto);
      if (direto !== null) return { valor: Math.max(0, direto), texto: '' };
      const texto = textoDe(bruto);
      if (!texto) return { valor: 0, texto: '' };
      const achado = texto.match(/\d[\d.]*(?:,\d+)?/);
      return { valor: achado ? numeroDe(achado[0]) || 0 : 0, texto };
    }

    function adicionarPromotor(linha) {
      const nome = textoDe(pegar(linha, 'nome'));
      if (!nome) return ignorar('Linha sem nome');
      if (normalizar(nome) === 'nome') return ignorar('Linha de cabeçalho repetida'); // o cadastro repete o título a cada grupo
      const separado = separarCargo(nome);
      const item = {
        nome: separado.nome,
        cargo: textoDe(pegar(linha, 'cargo')) || separado.cargo,
        codigo: textoDe(pegar(linha, 'codigo')),
        tipo: tipoDe(pegar(linha, 'tipo'), tipoPadrao),
        agencia: textoDe(pegar(linha, 'agencia')),
        empresa: textoDe(pegar(linha, 'empresa')),
        regiao: textoDe(pegar(linha, 'regiao')),
        telefone: textoDe(pegar(linha, 'telefone')),
        admissao: dataDe(pegar(linha, 'admissao')),
      };
      const textos = [];
      for (const campo of CAMPOS_DINHEIRO) {
        const bruto = pegar(linha, campo);
        // Célula vazia (ou coluna que não existe no arquivo) vai como null: o servidor mantém o valor do sistema.
        if (textoDe(bruto) === '') { item[campo] = null; continue; }
        const { valor, texto } = dinheiroDe(bruto);
        item[campo] = Math.round(valor * 100) / 100;
        if (texto) textos.push(`${campo.replace('_', ' ')}: "${texto}"`);
      }
      // O que veio escrito no lugar de número fica na observação, para nada se perder.
      item.observacao = textos.length ? `Conferir (veio texto na planilha) — ${textos.join('; ')}` : '';
      if (textos.length) avisar('Promotor com texto no lugar de valor (veja a observação no cadastro)');
      const chave = `${item.codigo}|${normalizar(nome)}|${normalizar(item.empresa)}`;
      if (somas.has(chave)) avisar('Promotor repetido no arquivo (ficou a última linha)');
      somas.set(chave, item);
    }

    return {
      adicionar: { faturamento: adicionarFaturamento, visitas: adicionarVisita, promotores: adicionarPromotor }[tipo],
      resultado() {
        const arredondar = (v) => (v === null ? null : Math.round(v * 100) / 100);
        const itens = [...somas.values()].map((item) => {
          if (tipo === 'faturamento') return { ...item, valor: arredondar(item.valor) };
          if (tipo === 'visitas') return { ...item, custo: arredondar(item.custo) };
          return item;
        });
        return { itens, motivos, avisos };
      },
    };
  }

  return { CAMPOS, TIPOS_VALIDOS, ufDe, chaveDaLoja, separarCargo, ehSupervisor, separarSupervisores, codigoNormal, acharPorNome, CAMPOS_DINHEIRO, primeiroNome, normalizar, sugerirMapa, analisar, textoDe, numeroDe, cnpjDe, cnpjValido, dataDe, mesDe, mesValido, textoDoHtml, criarLeitor, lerTexto, criarAgrupador };
});
