// Importação das planilhas: faturamento (exportado do FoccoERP) e visitas (planilhas das agências/promotores).
const { transacao } = require('./db');
const { normalizar, textoDe, numeroDe, cnpjDe, mesDe, mesValido } = require('./planilha');

class ErroDeImportacao extends Error {}

// Prepara a leitura: escolhe a aba, pula o cabeçalho e cria a função que pega o valor de um campo na linha.
function preparar(abas, opcoes, obrigatorios) {
  const aba = abas.find((a) => a.nome === opcoes.aba) || abas[0];
  const mapa = {};
  for (const [campo, coluna] of Object.entries(opcoes.mapa || {})) {
    if (coluna !== '' && coluna !== null && Number.isInteger(Number(coluna))) mapa[campo] = Number(coluna);
  }
  for (const grupo of obrigatorios) {
    if (!grupo.campos.some((campo) => mapa[campo] !== undefined)) throw new ErroDeImportacao(grupo.mensagem);
  }
  const inicio = (Number(opcoes.linhaCabecalho) || 0) + 1;
  const pegar = (linha, campo) => (mapa[campo] === undefined ? '' : linha[mapa[campo]] ?? '');
  return { linhas: aba.linhas.slice(inicio), pegar };
}

function contarMotivo(motivos, motivo) {
  motivos[motivo] = (motivos[motivo] || 0) + 1;
}

// Lê os dados da loja de uma linha. Devolve null se a linha não tem loja (linha de total, linha em branco...).
function lojaDaLinha(linha, pegar) {
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

// Procura a loja no banco (pelo CNPJ; sem CNPJ, pelo nome). Se não existir, cadastra.
async function acharOuCriarLoja(rodar, loja, cache, contagem) {
  if (cache.has(loja.chave)) return cache.get(loja.chave);
  let id;
  if (loja.cnpj) {
    const [porCnpj] = await rodar('SELECT id FROM lojas WHERE cnpj = $1', [loja.cnpj]);
    if (porCnpj) id = porCnpj.id;
    else {
      // Loja que já existia só com o nome (veio de uma planilha sem CNPJ): aproveita e grava o CNPJ.
      const [porNome] = await rodar('SELECT id FROM lojas WHERE cnpj IS NULL AND lower(nome) = lower($1) ORDER BY id LIMIT 1', [loja.nome]);
      if (porNome) {
        id = porNome.id;
        await rodar('UPDATE lojas SET cnpj = $1 WHERE id = $2', [loja.cnpj, id]);
      }
    }
  } else {
    const [porNome] = await rodar('SELECT id FROM lojas WHERE lower(nome) = lower($1) ORDER BY id LIMIT 1', [loja.nome]);
    if (porNome) id = porNome.id;
  }
  if (!id) {
    const [nova] = await rodar(
      'INSERT INTO lojas (nome, cnpj, cidade, uf, endereco) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [loja.nome, loja.cnpj || null, loja.cidade, loja.uf, loja.endereco],
    );
    id = nova.id;
    contagem.lojasNovas++;
  }
  cache.set(loja.chave, id);
  return id;
}

async function registrarImportacao(rodar, tipo, opcoes, usuario) {
  const [imp] = await rodar('INSERT INTO importacoes (tipo, arquivo, usuario) VALUES ($1, $2, $3) RETURNING id', [tipo, opcoes.arquivo || '', usuario]);
  return imp.id;
}

async function fecharImportacao(rodar, id, resultado) {
  await rodar('UPDATE importacoes SET linhas = $1, ignoradas = $2, total = $3, meses = $4 WHERE id = $5',
    [resultado.importadas, resultado.ignoradas, resultado.total, resultado.meses.join(', '), id]);
}

// ---------- Faturamento ----------
// Soma as linhas do arquivo por loja + mês + empresa e grava. Se já existia valor para a mesma
// loja/mês/empresa, o valor novo SUBSTITUI o antigo (por isso exporte sempre o mês inteiro do Focco).
async function importarFaturamento(abas, opcoes, usuario) {
  const { linhas, pegar } = preparar(abas, opcoes, [
    { campos: ['valor'], mensagem: 'Indique qual coluna tem o valor faturado.' },
    { campos: ['cnpj', 'loja'], mensagem: 'Indique a coluna do CNPJ ou do nome da loja.' },
  ]);
  if (opcoes.mes && !mesValido(opcoes.mes)) throw new ErroDeImportacao('Mês inválido.');
  const empresaPadrao = textoDe(opcoes.empresa);

  const somas = new Map();
  const motivos = {};
  for (const linha of linhas) {
    const loja = lojaDaLinha(linha, pegar);
    if (!loja) { contarMotivo(motivos, 'Sem loja (linha de total ou em branco)'); continue; }
    const valor = numeroDe(pegar(linha, 'valor'));
    if (valor === null) { contarMotivo(motivos, 'Valor não é número'); continue; }
    const mes = mesDe(pegar(linha, 'data')) || opcoes.mes;
    if (!mes) { contarMotivo(motivos, 'Sem data/mês (informe o mês na tela)'); continue; }
    const empresa = textoDe(pegar(linha, 'empresa')) || empresaPadrao;
    const chave = `${loja.chave}|${mes}|${empresa.toLowerCase()}`;
    if (!somas.has(chave)) somas.set(chave, { loja, mes, empresa, valor: 0 });
    somas.get(chave).valor += valor;
  }
  if (!somas.size) throw new ErroDeImportacao(`Nenhuma linha válida no arquivo. ${Object.keys(motivos).join('; ')}`);

  return transacao(async (rodar) => {
    const contagem = { lojasNovas: 0 };
    const cache = new Map();
    const importacaoId = await registrarImportacao(rodar, 'faturamento', opcoes, usuario);
    let total = 0;
    for (const item of somas.values()) {
      const lojaId = await acharOuCriarLoja(rodar, item.loja, cache, contagem);
      await rodar(
        `INSERT INTO faturamento (loja_id, mes, empresa, valor, importacao_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (loja_id, mes, empresa) DO UPDATE SET valor = EXCLUDED.valor, importacao_id = EXCLUDED.importacao_id`,
        [lojaId, item.mes, item.empresa, Math.round(item.valor * 100) / 100, importacaoId],
      );
      total += item.valor;
    }
    const resultado = {
      importadas: somas.size,
      ignoradas: Object.values(motivos).reduce((a, b) => a + b, 0),
      motivos,
      lojasNovas: contagem.lojasNovas,
      total: Math.round(total * 100) / 100,
      meses: [...new Set([...somas.values()].map((i) => i.mes))].sort(),
    };
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Visitas ----------

function tipoDe(texto, padrao) {
  const t = normalizar(texto);
  if (t.includes('clt')) return 'CLT';
  if (t.includes('mei')) return 'MEI';
  if (t.includes('agenc')) return 'AGENCIA';
  return padrao;
}

// Cada linha vira um atendimento (promotor + loja + mês) com visitas e custo.
// O promotor vem da coluna "Promotor" do arquivo; se o arquivo não tiver essa coluna
// (caso das agências), vale o promotor escolhido na tela.
async function importarVisitas(abas, opcoes, usuario) {
  const { linhas, pegar } = preparar(abas, opcoes, [
    { campos: ['cnpj', 'loja'], mensagem: 'Indique a coluna do CNPJ ou do nome da loja.' },
  ]);
  if (opcoes.mes && !mesValido(opcoes.mes)) throw new ErroDeImportacao('Mês inválido.');
  const novo = opcoes.promotorNovo || {};
  const tipoPadrao = ['CLT', 'MEI', 'AGENCIA'].includes(novo.tipo) ? novo.tipo : 'AGENCIA';

  const somas = new Map();
  const motivos = {};
  for (const linha of linhas) {
    const loja = lojaDaLinha(linha, pegar);
    if (!loja) { contarMotivo(motivos, 'Sem loja (linha de total ou em branco)'); continue; }
    const mes = mesDe(pegar(linha, 'data')) || opcoes.mes;
    if (!mes) { contarMotivo(motivos, 'Sem mês (informe o mês na tela)'); continue; }
    const nomePromotor = textoDe(pegar(linha, 'promotor'));
    if (!nomePromotor && !opcoes.promotorId && !textoDe(novo.nome)) {
      contarMotivo(motivos, 'Sem promotor (escolha o promotor na tela)'); continue;
    }
    const promotor = nomePromotor
      ? { chave: `nome:${nomePromotor.toLowerCase()}`, nome: nomePromotor, tipo: tipoDe(pegar(linha, 'tipo'), tipoPadrao), agencia: textoDe(pegar(linha, 'agencia')) || textoDe(novo.agencia) }
      : opcoes.promotorId
        ? { chave: `id:${opcoes.promotorId}`, id: Number(opcoes.promotorId) }
        : { chave: `nome:${textoDe(novo.nome).toLowerCase()}`, nome: textoDe(novo.nome), tipo: tipoPadrao, agencia: textoDe(novo.agencia) };
    const visitas = Math.max(0, Math.round(numeroDe(pegar(linha, 'visitas')) || 0));
    const custo = numeroDe(pegar(linha, 'custo'));
    const chave = `${promotor.chave}|${loja.chave}|${mes}`;
    if (!somas.has(chave)) somas.set(chave, { promotor, loja, mes, visitas: 0, custo: null });
    const item = somas.get(chave);
    item.visitas += visitas;
    if (custo !== null) item.custo = (item.custo || 0) + custo;
  }
  if (!somas.size) throw new ErroDeImportacao(`Nenhuma linha válida no arquivo. ${Object.keys(motivos).join('; ')}`);

  return transacao(async (rodar) => {
    const contagem = { lojasNovas: 0, promotoresNovos: 0 };
    const cacheLojas = new Map();
    const cachePromotores = new Map();
    const importacaoId = await registrarImportacao(rodar, 'visitas', opcoes, usuario);

    const acharOuCriarPromotor = async (p) => {
      if (cachePromotores.has(p.chave)) return cachePromotores.get(p.chave);
      let id;
      if (p.id) {
        const [existe] = await rodar('SELECT id FROM promotores WHERE id = $1', [p.id]);
        if (!existe) throw new ErroDeImportacao('O promotor escolhido não existe mais.');
        id = existe.id;
      } else {
        const [existe] = await rodar('SELECT id FROM promotores WHERE lower(nome) = lower($1)', [p.nome]);
        if (existe) id = existe.id;
        else {
          const [criado] = await rodar('INSERT INTO promotores (nome, tipo, agencia) VALUES ($1, $2, $3) RETURNING id', [p.nome, p.tipo, p.agencia]);
          id = criado.id;
          contagem.promotoresNovos++;
        }
      }
      cachePromotores.set(p.chave, id);
      return id;
    };

    let total = 0;
    for (const item of somas.values()) {
      const promotorId = await acharOuCriarPromotor(item.promotor);
      const lojaId = await acharOuCriarLoja(rodar, item.loja, cacheLojas, contagem);
      const custo = item.custo === null ? null : Math.round(item.custo * 100) / 100;
      await rodar(
        `INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo, importacao_id) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (promotor_id, loja_id, mes) DO UPDATE
           SET qtd_visitas = EXCLUDED.qtd_visitas, custo = EXCLUDED.custo, importacao_id = EXCLUDED.importacao_id`,
        [promotorId, lojaId, item.mes, item.visitas, custo, importacaoId],
      );
      total += custo || 0;
    }
    const resultado = {
      importadas: somas.size,
      ignoradas: Object.values(motivos).reduce((a, b) => a + b, 0),
      motivos,
      lojasNovas: contagem.lojasNovas,
      promotoresNovos: contagem.promotoresNovos,
      total: Math.round(total * 100) / 100,
      meses: [...new Set([...somas.values()].map((i) => i.mes))].sort(),
    };
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

module.exports = { importarFaturamento, importarVisitas, ErroDeImportacao };
