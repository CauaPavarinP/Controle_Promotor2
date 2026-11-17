// Gravação das importações: faturamento (FoccoERP) e visitas (agências, CLTs, MEIs).
// O navegador já leu o arquivo e somou as linhas (ver public/js/planilha-comum.js). Aqui chegam só os
// "itens" prontos. Mesmo assim conferimos tudo de novo: o servidor nunca confia no que vem do navegador.
const { transacao } = require('./db');
const { mesValido, primeiroNome, ufDe, chaveDaLoja, TIPOS_VALIDOS, CAMPOS_DINHEIRO } = require('./planilha');

class ErroDeImportacao extends Error {}

const MAX_ITENS = 300000;
const LOTE = 1000; // quantas linhas gravamos por comando SQL

// Limpa um texto: tira o caractere nulo (o PostgreSQL não aceita) e corta no tamanho máximo.
const texto = (v, tamanho) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, tamanho);

// O maior valor que cabe nas colunas de dinheiro do banco (NUMERIC(14,2)).
const VALOR_MAXIMO = 999999999999.99;

function conferirLoja(loja) {
  if (!loja || typeof loja !== 'object') throw new ErroDeImportacao('Há um registro sem loja nos dados enviados.');
  const cnpj = String(loja?.cnpj ?? '').trim();
  if (cnpj && !/^\d{11,14}$/.test(cnpj)) throw new ErroDeImportacao('CNPJ inválido nos dados enviados.');
  const nome = texto(loja?.nome, 200);
  if (!cnpj && !nome) throw new ErroDeImportacao('Há um registro sem loja nos dados enviados.');
  const cidade = texto(loja.cidade, 100);
  const nomeFinal = nome || `CNPJ ${cnpj}`;
  return {
    // A chave é recalculada aqui (não vale a que veio do navegador): CNPJ + nome + cidade.
    chave: chaveDaLoja(cnpj, nomeFinal, cidade),
    cnpj,
    nome: nomeFinal,
    cidade,
    uf: ufDe(loja.uf) || texto(loja.uf, 40),
    endereco: texto(loja.endereco, 200),
  };
}

function conferirMes(mes) {
  if (!mesValido(mes)) throw new ErroDeImportacao('Mês inválido nos dados enviados.');
  return mes;
}

function conferirNumero(valor, { minimo, nome }) {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < minimo || Math.abs(valor) > VALOR_MAXIMO) {
    throw new ErroDeImportacao(`${nome} inválido nos dados enviados.`);
  }
  return Math.round(valor * 100) / 100;
}

function conferirEnvio(dados) {
  if (!Array.isArray(dados?.itens) || !dados.itens.length) throw new ErroDeImportacao('Nenhuma linha válida no arquivo.');
  if (dados.itens.length > MAX_ITENS) throw new ErroDeImportacao('Arquivo com registros demais para uma importação só. Divida por período.');
  if (dados.itens.some((item) => !item || typeof item !== 'object')) throw new ErroDeImportacao('Os dados enviados estão em formato inválido.');
  // "motivos" = por que linhas foram ignoradas; "avisos" = linhas que entraram com algo a conferir.
  // Vêm do navegador só para registro e para a mensagem final.
  const contagens = (origem) => {
    const limpo = {};
    for (const [frase, quantidade] of Object.entries(origem || {}).slice(0, 20)) {
      if (Number.isInteger(quantidade) && quantidade > 0) limpo[texto(frase, 120)] = quantidade;
    }
    return limpo;
  };
  return { motivos: contagens(dados.motivos), avisos: contagens(dados.avisos) };
}

// Descobre o id de cada loja dos itens, cadastrando as que ainda não existem. A loja é identificada pela
// chave (CNPJ + nome + cidade). Devolve um Map: chave da loja -> id.
// Faz tudo com poucos comandos SQL (um SELECT e INSERTs em lote), porque um arquivo pode trazer milhares de lojas.
async function resolverLojas(rodar, itens, contagem) {
  const porChave = new Map();
  for (const l of await rodar('SELECT id, chave FROM lojas')) porChave.set(l.chave, l.id);
  const ids = new Map();
  const novas = new Map();
  for (const { loja } of itens) {
    if (ids.has(loja.chave) || novas.has(loja.chave)) continue;
    if (porChave.has(loja.chave)) { ids.set(loja.chave, porChave.get(loja.chave)); continue; }
    // A loja já existia sem CNPJ (veio de uma planilha anterior sem ele) e agora chegou com CNPJ:
    // aproveita o mesmo cadastro e grava o CNPJ, para o histórico da loja não se dividir em dois.
    const semCnpj = loja.cnpj ? chaveDaLoja('', loja.nome, loja.cidade) : null;
    if (semCnpj && porChave.has(semCnpj)) {
      const id = porChave.get(semCnpj);
      await rodar('UPDATE lojas SET cnpj = $1, chave = $2 WHERE id = $3', [loja.cnpj, loja.chave, id]);
      porChave.delete(semCnpj);
      porChave.set(loja.chave, id);
      ids.set(loja.chave, id);
      continue;
    }
    novas.set(loja.chave, loja);
  }

  const lista = [...novas.values()];
  for (let i = 0; i < lista.length; i += LOTE) {
    const lote = lista.slice(i, i + LOTE);
    const criadas = await rodar(
      `INSERT INTO lojas (nome, cnpj, chave, cidade, uf, endereco)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       RETURNING id, chave`,
      [lote.map((l) => l.nome), lote.map((l) => l.cnpj || null), lote.map((l) => l.chave), lote.map((l) => l.cidade), lote.map((l) => l.uf), lote.map((l) => l.endereco)],
    );
    for (const criada of criadas) ids.set(criada.chave, criada.id);
  }
  contagem.lojasNovas = lista.length;
  return ids;
}

// Soma os valores e confere se o total cabe no banco (um valor absurdo indica coluna errada escolhida na tela).
function conferirTotal(valor) {
  if (Math.abs(valor) > VALOR_MAXIMO) {
    throw new ErroDeImportacao('O valor somado ficou grande demais. Confira se a coluna de valor escolhida é a certa.');
  }
  return Math.round(valor * 100) / 100;
}

async function registrarImportacao(rodar, tipo, arquivo, usuario) {
  const [imp] = await rodar('INSERT INTO importacoes (tipo, arquivo, usuario) VALUES ($1, $2, $3) RETURNING id', [tipo, texto(arquivo, 200), usuario]);
  return imp.id;
}

async function fecharImportacao(rodar, id, resultado) {
  await rodar('UPDATE importacoes SET linhas = $1, ignoradas = $2, total = $3, meses = $4 WHERE id = $5',
    [resultado.importadas, resultado.ignoradas, resultado.total, resultado.meses.join(', '), id]);
}

function montarResultado(registros, { motivos, avisos }, contagem, campoTotal) {
  return {
    importadas: registros.length,
    ignoradas: Object.values(motivos).reduce((a, b) => a + b, 0),
    motivos,
    avisos,
    ...contagem,
    total: conferirTotal(registros.reduce((soma, r) => soma + (r[campoTotal] || 0), 0)),
    meses: [...new Set(registros.map((r) => r.mes))].sort(),
  };
}

// ---------- Faturamento ----------
// Um valor por CNPJ + mês + empresa. Se já existia, o valor novo SUBSTITUI o antigo
// (por isso exporte sempre o mês inteiro do Focco). Nome, cidade e UF do cliente ficam em "clientes_erp".
async function gravarFaturamento(dados, usuario) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const loja = conferirLoja(item.loja);
    if (!loja.cnpj) throw new ErroDeImportacao('Há um registro de faturamento sem CNPJ nos dados enviados.');
    return { loja, mes: conferirMes(item.mes), empresa: texto(item.empresa, 60), valor: conferirNumero(item.valor, { minimo: -1e12, nome: 'Valor' }) };
  });

  return transacao(async (rodar) => {
    const importacaoId = await registrarImportacao(rodar, 'faturamento', dados.arquivo, usuario);

    // Clientes do ERP: grava ou atualiza nome, cidade e UF (vale o que veio por último no arquivo).
    const clientes = new Map();
    for (const { loja } of itens) clientes.set(loja.cnpj, loja);
    const existentes = new Set((await rodar('SELECT cnpj FROM clientes_erp WHERE cnpj = ANY($1::text[])', [[...clientes.keys()]])).map((c) => c.cnpj));
    const listaClientes = [...clientes.values()];
    for (let i = 0; i < listaClientes.length; i += LOTE) {
      const lote = listaClientes.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO clientes_erp (cnpj, nome, cidade, uf)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
         ON CONFLICT (cnpj) DO UPDATE SET nome = EXCLUDED.nome, cidade = EXCLUDED.cidade, uf = EXCLUDED.uf, atualizado_em = now()`,
        [lote.map((c) => c.cnpj), lote.map((c) => c.nome), lote.map((c) => c.cidade), lote.map((c) => c.uf)],
      );
    }

    // Soma de novo por CNPJ + mês + empresa, para nunca gravar a mesma chave duas vezes.
    const somas = new Map();
    for (const item of itens) {
      const chave = `${item.loja.cnpj}|${item.mes}|${item.empresa}`;
      if (!somas.has(chave)) somas.set(chave, { cnpj: item.loja.cnpj, mes: item.mes, empresa: item.empresa, valor: 0 });
      somas.get(chave).valor += item.valor;
    }
    const registros = [...somas.values()];
    for (const r of registros) r.valor = conferirTotal(r.valor);
    for (let i = 0; i < registros.length; i += LOTE) {
      const lote = registros.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO faturamento_erp (cnpj, mes, empresa, valor, importacao_id)
         SELECT cnpj, mes, empresa, valor, $5::int FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[]) AS t(cnpj, mes, empresa, valor)
         ON CONFLICT (cnpj, mes, empresa) DO UPDATE SET valor = EXCLUDED.valor, importacao_id = EXCLUDED.importacao_id`,
        [lote.map((r) => r.cnpj), lote.map((r) => r.mes), lote.map((r) => r.empresa), lote.map((r) => r.valor), importacaoId],
      );
    }
    const contagem = { clientesNovos: listaClientes.filter((c) => !existentes.has(c.cnpj)).length };
    const resultado = montarResultado(registros, registro, contagem, 'valor');
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Promotores ----------

// Carrega o cadastro de promotores e devolve uma forma de achar "o mesmo promotor" que veio na planilha.
// Regra para ser o mesmo:
//   1º) mesmo código E mesmo primeiro nome (o código sozinho se repete entre empresas; e nas planilhas de
//       atendimento vem só o primeiro nome, enquanto o cadastro traz o nome completo);
//   2º) mesmo nome e mesma agência.
async function carregarPromotores(rodar) {
  const porId = new Map();
  const lista = [];
  const incluir = (p) => { porId.set(p.id, p); lista.push(p); };
  for (const p of await rodar('SELECT * FROM promotores ORDER BY id')) incluir(p);
  const achar = ({ nome, agencia = '', codigo = '' }) => {
    const primeiro = primeiroNome(nome);
    return (codigo && lista.find((p) => p.codigo === codigo && primeiroNome(p.nome) === primeiro))
      || lista.find((p) => p.nome.toLowerCase() === nome.toLowerCase() && p.agencia.toLowerCase() === agencia.toLowerCase())
      || null;
  };
  return { porId, achar, incluir };
}

// Cadastro de promotores com os custos mensais (aba "Promotores CLT" do modelo).
// Quem já existe é atualizado (salário e demais valores passam a ser os da planilha); quem não existe é criado.
async function gravarPromotores(dados, usuario) {
  const registro = conferirEnvio(dados);
  const COLUNAS = ['nome', 'tipo', 'agencia', 'codigo', 'empresa', 'regiao', 'admissao', ...CAMPOS_DINHEIRO];
  const itens = dados.itens.map((item) => {
    const p = {
      nome: texto(item.nome, 120),
      tipo: TIPOS_VALIDOS.includes(item.tipo) ? item.tipo : 'CLT',
      agencia: texto(item.agencia, 120),
      codigo: texto(item.codigo, 30),
      empresa: texto(item.empresa, 120),
      regiao: texto(item.regiao, 120),
      telefone: texto(item.telefone, 40),
      observacao: texto(item.observacao, 500),
      admissao: /^\d{4}-\d{2}-\d{2}$/.test(item.admissao || '') ? item.admissao : '',
    };
    if (!p.nome) throw new ErroDeImportacao('Há um promotor sem nome nos dados enviados.');
    for (const campo of CAMPOS_DINHEIRO) p[campo] = conferirNumero(item[campo] ?? 0, { minimo: 0, nome: 'Valor do cadastro' });
    return p;
  });

  return transacao(async (rodar) => {
    const importacaoId = await registrarImportacao(rodar, 'promotores', dados.arquivo, usuario);
    const cadastro = await carregarPromotores(rodar);
    const contagem = { promotoresNovos: 0, promotoresAtualizados: 0 };
    let total = 0;
    for (const p of itens) {
      const valores = COLUNAS.map((coluna) => p[coluna]);
      const existente = cadastro.achar(p);
      if (existente) {
        // Mantém a agência que já estava (ex.: veio da planilha de atendimentos) se o cadastro não trouxer.
        valores[COLUNAS.indexOf('agencia')] = p.agencia || existente.agencia;
        const atribuicoes = COLUNAS.map((coluna, i) => `${coluna} = $${i + 1}`).join(', ');
        await rodar(
          `UPDATE promotores SET ${atribuicoes},
             telefone = CASE WHEN $${COLUNAS.length + 1} <> '' THEN $${COLUNAS.length + 1} ELSE telefone END,
             observacao = CASE WHEN $${COLUNAS.length + 2} <> '' THEN $${COLUNAS.length + 2} ELSE observacao END
           WHERE id = $${COLUNAS.length + 3}`,
          [...valores, p.telefone, p.observacao, existente.id],
        );
        Object.assign(existente, p, { agencia: valores[COLUNAS.indexOf('agencia')] });
        contagem.promotoresAtualizados++;
      } else {
        const marcadores = [...COLUNAS, 'telefone', 'observacao'].map((_, i) => `$${i + 1}`).join(', ');
        const [criado] = await rodar(
          `INSERT INTO promotores (${COLUNAS.join(', ')}, telefone, observacao) VALUES (${marcadores}) RETURNING *`,
          [...valores, p.telefone, p.observacao],
        );
        cadastro.incluir(criado);
        contagem.promotoresNovos++;
      }
      total += CAMPOS_DINHEIRO.reduce((soma, campo) => soma + p[campo], 0);
    }
    const resultado = {
      importadas: itens.length,
      ignoradas: Object.values(registro.motivos).reduce((a, b) => a + b, 0),
      ...registro,
      ...contagem,
      total: conferirTotal(total), // soma dos custos mensais de todos os promotores do arquivo
      meses: [],
    };
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Visitas ----------
// Um registro por promotor + loja + mês. Se já existia, o novo SUBSTITUI o antigo.
async function gravarVisitas(dados, usuario) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const p = item.promotor || {};
    const promotor = Number.isInteger(p.id) && p.id > 0
      ? { id: p.id }
      : { nome: texto(p.nome, 120), tipo: TIPOS_VALIDOS.includes(p.tipo) ? p.tipo : 'AGENCIA', agencia: texto(p.agencia, 120), codigo: texto(p.codigo, 30) };
    if (!promotor.id && !promotor.nome) throw new ErroDeImportacao('Há um registro sem promotor nos dados enviados.');
    if (!Number.isInteger(item.visitas) || item.visitas < 0 || item.visitas > 9999) throw new ErroDeImportacao('Quantidade de visitas inválida nos dados enviados.');
    return {
      promotor,
      loja: conferirLoja(item.loja),
      mes: conferirMes(item.mes),
      visitas: item.visitas,
      custo: item.custo === null || item.custo === undefined ? null : conferirNumero(item.custo, { minimo: 0, nome: 'Custo' }),
      dias: texto(item.dias, 80),
      status: texto(item.status, 30),
      supervisor: texto(item.supervisor, 80),
      observacao: texto(item.observacao, 400),
    };
  });

  return transacao(async (rodar) => {
    const contagem = { lojasNovas: 0, promotoresNovos: 0 };
    const lojas = await resolverLojas(rodar, itens, contagem);
    const importacaoId = await registrarImportacao(rodar, 'visitas', dados.arquivo, usuario);
    const cadastro = await carregarPromotores(rodar);

    const promotores = new Map();
    const acharPromotor = async (p) => {
      const chave = p.id ? `id:${p.id}` : `${p.codigo}|${p.nome.toLowerCase()}|${p.agencia.toLowerCase()}`;
      if (promotores.has(chave)) return promotores.get(chave);
      let id;
      if (p.id) {
        if (!cadastro.porId.has(p.id)) throw new ErroDeImportacao('O promotor escolhido não existe mais.');
        id = p.id;
      } else {
        const existente = cadastro.achar(p);
        if (existente) id = existente.id;
        else {
          const [criado] = await rodar('INSERT INTO promotores (nome, tipo, agencia, codigo) VALUES ($1, $2, $3, $4) RETURNING *', [p.nome, p.tipo, p.agencia, p.codigo]);
          cadastro.incluir(criado);
          id = criado.id;
          contagem.promotoresNovos++;
        }
      }
      promotores.set(chave, id);
      return id;
    };

    const somas = new Map();
    for (const item of itens) {
      const promotorId = await acharPromotor(item.promotor);
      const lojaId = lojas.get(item.loja.chave);
      const chave = `${promotorId}|${lojaId}|${item.mes}`;
      if (!somas.has(chave)) somas.set(chave, { promotorId, lojaId, mes: item.mes, visitas: 0, custo: null, dias: '', status: '', supervisor: '', observacao: '' });
      const soma = somas.get(chave);
      soma.visitas += item.visitas;
      if (item.custo !== null) soma.custo = (soma.custo || 0) + item.custo;
      for (const campo of ['dias', 'status', 'supervisor', 'observacao']) soma[campo] = soma[campo] || item[campo];
    }
    const registros = [...somas.values()];
    for (const registro of registros) {
      if (registro.custo !== null) registro.custo = conferirTotal(registro.custo);
      if (registro.visitas > 100000) throw new ErroDeImportacao('Quantidade de visitas grande demais. Confira a coluna de visitas.');
    }
    for (let i = 0; i < registros.length; i += LOTE) {
      const lote = registros.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita, status, supervisor, observacao, importacao_id)
         SELECT promotor_id, loja_id, mes, qtd, custo, dias, status, supervisor, observacao, $10::int
         FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS t(promotor_id, loja_id, mes, qtd, custo, dias, status, supervisor, observacao)
         ON CONFLICT (promotor_id, loja_id, mes) DO UPDATE
           SET qtd_visitas = EXCLUDED.qtd_visitas, custo = EXCLUDED.custo, dias_visita = EXCLUDED.dias_visita, status = EXCLUDED.status,
               supervisor = EXCLUDED.supervisor, observacao = EXCLUDED.observacao, importacao_id = EXCLUDED.importacao_id`,
        [lote.map((r) => r.promotorId), lote.map((r) => r.lojaId), lote.map((r) => r.mes), lote.map((r) => r.visitas), lote.map((r) => r.custo),
          lote.map((r) => r.dias), lote.map((r) => r.status), lote.map((r) => r.supervisor), lote.map((r) => r.observacao), importacaoId],
      );
    }
    const resultado = montarResultado(registros, registro, contagem, 'custo');
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

module.exports = { gravarFaturamento, gravarVisitas, gravarPromotores, ErroDeImportacao };
