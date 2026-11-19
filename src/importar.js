// Gravação das importações: faturamento (FoccoERP) e visitas (agências, CLTs, MEIs).
// O navegador já leu o arquivo e somou as linhas (ver public/js/planilha-comum.js). Aqui chegam só os
// "itens" prontos. Mesmo assim conferimos tudo de novo: o servidor nunca confia no que vem do navegador.
const { transacao, consulta } = require('./db');
const { gravarSupervisor, ligarAtendimentos } = require('./ligacaoSupervisor');
const { ligarPendentesDe } = require('./ligacaoPromotor');
const {
  mesValido, primeiroNome, ufDe, chaveDaLoja, separarCargo, codigoNormal, normalizar, ehSupervisor, separarSupervisores, TIPOS_VALIDOS, CAMPOS_DINHEIRO,
} = require('./planilha');

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

// "restauravel": faturamento e atendimentos guardam cópia do que substituem, então podem ser desfeitos.
async function registrarImportacao(rodar, tipo, arquivo, usuario) {
  const [imp] = await rodar('INSERT INTO importacoes (tipo, arquivo, usuario, restauravel) VALUES ($1, $2, $3, $4) RETURNING id',
    [tipo, texto(arquivo, 200), usuario, tipo !== 'promotores']);
  return imp.id;
}

const NOMES_MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (mes) => `${NOMES_MESES[Number(mes.slice(5)) - 1]}/${mes.slice(0, 4)}`;

// Guarda as linhas que a importação vai apagar, para o "Desfazer" poder restaurá-las.
async function guardarCopia(rodar, importacaoId, tabela, linhas) {
  await rodar('INSERT INTO importacoes_backup (importacao_id, tabela, dados) VALUES ($1, $2, $3::jsonb)', [importacaoId, tabela, JSON.stringify(linhas)]);
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
// Importar COMPLEMENTA o que já existe (não apaga nada):
//  - mês + CNPJ + empresa que ainda não existe: entra;
//  - mês + CNPJ + empresa que já existe: o valor do arquivo SUBSTITUI o que estava (ex.: arquivo corrigido);
//  - o que já está no sistema e não veio no arquivo: continua.
// As linhas que já existiam e foram tocadas têm cópia guardada, para o "Desfazer" voltar como estavam.
function prepararFaturamento(dados) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const loja = conferirLoja(item.loja);
    if (!loja.cnpj) throw new ErroDeImportacao('Há um registro de faturamento sem CNPJ nos dados enviados.');
    return { loja, mes: conferirMes(item.mes), empresa: texto(item.empresa, 60), valor: conferirNumero(item.valor, { minimo: -1e12, nome: 'Valor' }) };
  });
  return { registro, itens, registros: somarFaturamento(itens) };
}

// Soma os itens do arquivo por CNPJ + mês + empresa (um arquivo do Focco traz uma linha por item de nota).
function somarFaturamento(itens) {
  const somas = new Map();
  for (const item of itens) {
    const chave = `${item.loja.cnpj}|${item.mes}|${item.empresa}`;
    if (!somas.has(chave)) somas.set(chave, { cnpj: item.loja.cnpj, nome: item.loja.nome, mes: item.mes, empresa: item.empresa, valor: 0 });
    somas.get(chave).valor += item.valor;
  }
  const registros = [...somas.values()];
  for (const r of registros) r.valor = conferirTotal(r.valor);
  return registros;
}

const chaveFaturamento = (r) => `${r.cnpj}|${r.mes}|${r.empresa}`;
const mesmoValor = (a, b) => (a === null || a === undefined ? b === null || b === undefined
  : b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < 0.005);

// Linhas que já existem no sistema com as mesmas chaves (CNPJ + mês + empresa) dos registros do arquivo.
async function faturamentoQueJaExiste(rodar, registros) {
  const atuais = new Map();
  for (let i = 0; i < registros.length; i += LOTE) {
    const lote = registros.slice(i, i + LOTE);
    const linhas = await rodar(
      `SELECT f.cnpj, f.mes, f.empresa, f.valor, f.importacao_id FROM faturamento_erp f
       JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(cnpj, mes, empresa) ON f.cnpj = k.cnpj AND f.mes = k.mes AND f.empresa = k.empresa`,
      [lote.map((r) => r.cnpj), lote.map((r) => r.mes), lote.map((r) => r.empresa)],
    );
    for (const l of linhas) atuais.set(chaveFaturamento(l), l);
  }
  return atuais;
}

// Separa os registros do arquivo em novos, iguais (já existem com o mesmo valor) e diferentes.
function compararFaturamento(registros, atuais) {
  const grupos = { novos: [], iguais: [], diferentes: [] };
  for (const r of registros) {
    const atual = atuais.get(chaveFaturamento(r));
    if (!atual) grupos.novos.push(r);
    else if (mesmoValor(atual.valor, r.valor)) grupos.iguais.push(r);
    else grupos.diferentes.push({ ...r, antes: Number(atual.valor) });
  }
  return grupos;
}

async function gravarFaturamento(dados, usuario) {
  const { registro, itens, registros } = prepararFaturamento(dados);

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

    // Cópia das linhas que já existem com as mesmas chaves (passam a ser desta importação), para o Desfazer.
    const atuais = await faturamentoQueJaExiste(rodar, registros);
    const grupos = compararFaturamento(registros, atuais);
    await guardarCopia(rodar, importacaoId, 'faturamento_erp', [...atuais.values()]);

    // Grava: o que é novo entra; o que já existe fica com o valor do arquivo. Nada é apagado.
    for (let i = 0; i < registros.length; i += LOTE) {
      const lote = registros.slice(i, i + LOTE);
      await rodar(
        `INSERT INTO faturamento_erp (cnpj, mes, empresa, valor, importacao_id)
         SELECT cnpj, mes, empresa, valor, $5::int FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[]) AS t(cnpj, mes, empresa, valor)
         ON CONFLICT (cnpj, mes, empresa) DO UPDATE SET valor = EXCLUDED.valor, importacao_id = EXCLUDED.importacao_id`,
        [lote.map((r) => r.cnpj), lote.map((r) => r.mes), lote.map((r) => r.empresa), lote.map((r) => r.valor), importacaoId],
      );
    }
    const contagem = {
      clientesNovos: listaClientes.filter((c) => !existentes.has(c.cnpj)).length,
      novos: grupos.novos.length, iguais: grupos.iguais.length, substituidas: grupos.diferentes.length,
    };
    const resultado = montarResultado(registros, registro, contagem, 'valor');
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Promotores ----------


// Carrega o cadastro de promotores e devolve duas formas de achar "o mesmo promotor" que veio na planilha.
//
// achar (usada no CADASTRO de promotores). Devolve { promotor } ou { promotor: null, ambiguo: true }:
//   1º) mesmo código E mesmo primeiro nome (código sem zeros à esquerda: "06" = "6");
//   2º) mesmo código E mesma agência (a agência ou a empresa da planilha igual à agência ou à empresa do sistema);
//   3º) mesmo nome normalizado (sem acento, minúsculo, sem espaços duplos), preferindo quem já está cadastrado.
//       Mais de um com o mesmo nome e nenhum código para desempatar: não adivinha (ambiguo).
//
// identificar (usada nos ATENDIMENTOS; nem todo CLT, MEI ou promotor de agência tem código):
//   1º) com código: código + primeiro nome;
//   2º) ligação feita à mão na tela (nome da planilha + agência -> promotor);
//   3º) nome completo + agência (sem acento, sem diferenciar maiúsculas);
//   4º) primeiro nome + agência ou empresa, mas SÓ se houver um único promotor que bata.
//   Com mais de um, não adivinha: devolve "ambiguo" e a lista de candidatos.
async function carregarPromotores(rodar) {
  const porId = new Map();
  const lista = [];
  const incluir = (p) => { porId.set(p.id, p); lista.push(p); };
  // Supervisor não é promotor: mesmo que algum ainda esteja na tabela (não pôde ser movido), não entra aqui.
  for (const p of await rodar('SELECT * FROM promotores ORDER BY id')) if (!ehSupervisor(p.cargo)) incluir(p);
  const vinculos = new Map();
  for (const v of await rodar('SELECT nome, agencia, promotor_id FROM vinculos_promotor')) vinculos.set(`${v.nome}|${v.agencia}`, v.promotor_id);

  const porCodigo = ({ nome, codigo = '' }) => {
    const cod = codigoNormal(codigo);
    const primeiro = primeiroNome(nome);
    return (cod && lista.find((p) => codigoNormal(p.codigo) === cod && primeiroNome(p.nome) === primeiro)) || null;
  };

  const achar = ({ nome, agencia = '', empresa = '', codigo = '' }) => {
    const peloCodigo = porCodigo({ nome, codigo });
    if (peloCodigo) return { promotor: peloCodigo };
    const cod = codigoNormal(codigo);
    const minhas = [agencia, empresa].map(normalizar).filter(Boolean);
    const daAgencia = cod && minhas.length
      ? lista.filter((p) => codigoNormal(p.codigo) === cod && [p.agencia, p.empresa].some((a) => minhas.includes(normalizar(a))))
      : [];
    if (daAgencia.length === 1) return { promotor: daAgencia[0] };
    const mesmoNome = lista.filter((p) => normalizar(p.nome) === normalizar(nome));
    const cadastrados = mesmoNome.filter((p) => p.cadastrado || !p.pendente);
    const escolhidos = cadastrados.length ? cadastrados : mesmoNome;
    if (escolhidos.length === 1) return { promotor: escolhidos[0] };
    return { promotor: null, ambiguo: escolhidos.length > 1 };
  };

  const identificar = ({ nome, agencia = '', codigo = '' }) => {
    const peloCodigo = porCodigo({ nome, codigo });
    if (peloCodigo) return { promotor: peloCodigo };
    const ag = normalizar(agencia);
    const vinculo = vinculos.get(`${normalizar(nome)}|${ag}`);
    if (vinculo && porId.has(vinculo)) return { promotor: porId.get(vinculo) };
    // O próprio promotor pendente de uma importação anterior também conta: assim não duplica a cada importação.
    const completo = lista.find((p) => normalizar(p.nome) === normalizar(nome) && normalizar(p.agencia) === ag);
    if (completo) return { promotor: completo };
    // Nome completo igual ao de UM ÚNICO promotor do cadastro (ex.: CLT cuja agência no arquivo é diferente da
    // empresa do cadastro). Com mais de um, segue para as regras abaixo.
    const doCadastro = lista.filter((p) => p.cadastrado && normalizar(p.nome) === normalizar(nome));
    if (doCadastro.length === 1) return { promotor: doCadastro[0] };
    const primeiro = primeiroNome(nome);
    const candidatos = lista.filter((p) => !p.pendente && primeiroNome(p.nome) === primeiro
      && ag && (normalizar(p.agencia) === ag || normalizar(p.empresa) === ag));
    if (candidatos.length === 1) return { promotor: candidatos[0] };
    if (candidatos.length > 1) return { promotor: null, motivo: 'ambiguo', candidatos };
    return { promotor: null, motivo: 'nao_encontrado', candidatos: [] };
  };

  return { porId, lista, achar, identificar, incluir };
}

// Cadastro de promotores com os custos mensais (aba "Promotores CLT" do modelo).
// Quem já existe é COMPLETADO: o que veio preenchido na planilha substitui o valor do sistema; célula vazia (ou coluna
// que não existe na planilha) mantém o que já estava, inclusive o que foi preenchido à mão. Quem não existe é criado.
// O cargo que vem grudado no nome ("NOME - Sup ll") é separado na coluna "cargo".
function prepararPromotores(dados) {
  const registro = conferirEnvio(dados);
  const itens = dados.itens.map((item) => {
    const separado = separarCargo(texto(item.nome, 160));
    const p = {
      nome: texto(separado.nome, 120),
      cargo: texto(item.cargo, 60) || texto(separado.cargo, 60),
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
    // null = célula vazia (não mexe no valor do sistema); um "0" escrito na planilha vale como zero.
    for (const campo of CAMPOS_DINHEIRO) {
      p[campo] = item[campo] === null || item[campo] === undefined || item[campo] === '' ? null : conferirNumero(item[campo], { minimo: 0, nome: 'Valor do cadastro' });
    }
    return p;
  });
  return { registro, itens };
}

async function gravarPromotores(dados, usuario) {
  const { registro, itens: todos } = prepararPromotores(dados);
  // Supervisor não é promotor: entra só no cadastro de supervisores (nome, código, cargo e empresa).
  const supervisores = todos.filter((p) => ehSupervisor(p.cargo));
  const itens = todos.filter((p) => !ehSupervisor(p.cargo));
  const COLUNAS = ['nome', 'cargo', 'tipo', 'agencia', 'codigo', 'empresa', 'regiao', 'admissao', ...CAMPOS_DINHEIRO];
  return transacao(async (rodar) => {
    const importacaoId = await registrarImportacao(rodar, 'promotores', dados.arquivo, usuario);
    const cadastro = await carregarPromotores(rodar);
    const contagem = { promotoresNovos: 0, promotoresAtualizados: 0, supervisoresNovos: 0, supervisoresAtualizados: 0 };
    for (const sup of supervisores) {
      if (await gravarSupervisor(rodar, sup)) contagem.supervisoresNovos++; else contagem.supervisoresAtualizados++;
    }
    let total = 0;
    const ligados = [];
    let ambiguos = 0;
    for (const p of itens) {
      const { promotor: existente, ambiguo } = cadastro.achar(p);
      if (ambiguo) { ambiguos++; continue; } // mais de um com esse nome e sem código: não adivinha
      let id;
      if (existente) {
        // Completa: só o que veio preenchido substitui. Vazio mantém o valor do sistema.
        const novos = {};
        for (const coluna of [...COLUNAS, 'telefone', 'observacao']) {
          const valor = p[coluna];
          if (valor !== null && valor !== undefined && valor !== '') novos[coluna] = valor;
        }
        const colunas = Object.keys(novos);
        await rodar(
          `UPDATE promotores SET ${colunas.map((c, i) => `${c} = $${i + 1}, `).join('')}cadastrado = TRUE, pendente = ''
           WHERE id = $${colunas.length + 1}`,
          [...colunas.map((c) => novos[c]), existente.id],
        );
        Object.assign(existente, novos, { cadastrado: true, pendente: '' });
        id = existente.id;
        contagem.promotoresAtualizados++;
      } else {
        const valores = [...COLUNAS, 'telefone', 'observacao'].map((coluna) => (CAMPOS_DINHEIRO.includes(coluna) ? p[coluna] || 0 : p[coluna]));
        const marcadores = valores.map((_, i) => `$${i + 1}`).join(', ');
        const [criado] = await rodar(
          `INSERT INTO promotores (${COLUNAS.join(', ')}, telefone, observacao, cadastrado, pendente) VALUES (${marcadores}, TRUE, '') RETURNING *`,
          valores,
        );
        cadastro.incluir(criado);
        id = criado.id;
        contagem.promotoresNovos++;
      }
      // Pendentes (criados pela importação de atendimentos) que são esta mesma pessoa: liga e apaga o duplicado.
      for (const ligado of await ligarPendentesDe(rodar, id)) {
        ligados.push(ligado);
        const i = cadastro.lista.findIndex((x) => normalizar(x.nome) === normalizar(ligado.nome) && x.pendente);
        if (i >= 0) cadastro.lista.splice(i, 1);
      }
      total += CAMPOS_DINHEIRO.reduce((soma, campo) => soma + (p[campo] || 0), 0);
    }
    if (ambiguos) registro.avisos['Mais de um promotor com o mesmo nome no sistema e sem código para desempatar (não atualizado)'] = ambiguos;
    contagem.pendentesLigados = ligados.length;
    contagem.atendimentosLigados = ligados.reduce((s, l) => s + l.atendimentos, 0);
    const resultado = {
      importadas: todos.length,
      ignoradas: Object.values(registro.motivos).reduce((a, b) => a + b, 0),
      ...registro,
      ...contagem,
      total: conferirTotal(total), // soma dos custos mensais dos promotores do arquivo (sem os supervisores)
      meses: [],
    };
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Atendimentos (visitas) ----------
// Importar COMPLEMENTA o que já existe (não apaga nada). O "mesmo atendimento" é o mesmo promotor, na mesma
// loja, no mesmo mês:
//  - não existe no sistema: entra;
//  - existe com os mesmos valores: fica como está;
//  - existe com valores diferentes: a pessoa escolhe na confirmação. "substituir" (padrão): vale o arquivo.
//    "somar": visitas e valor somados, e os supervisores dos dois juntos.
//  - o que já está no sistema e não veio no arquivo continua, inclusive o que foi lançado à mão.
// As linhas que já existiam e foram tocadas têm cópia guardada, para o "Desfazer" voltar como estavam.
function prepararVisitas(dados) {
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
  return { registro, itens, meses: [...new Set(itens.map((i) => i.mes))].sort(), modo: dados.modo === 'somar' ? 'somar' : 'substituir' };
}

const CAMPOS_TEXTO = ['dias', 'status', 'supervisor', 'observacao'];

// Junta as linhas do arquivo que são o mesmo atendimento (mesmo promotor, loja e mês): soma visitas e valor.
function acumularVisita(somas, chave, base, item) {
  if (!somas.has(chave)) somas.set(chave, { ...base, mes: item.mes, visitas: 0, custo: null, dias: '', status: '', supervisor: '', observacao: '' });
  const soma = somas.get(chave);
  soma.visitas += item.visitas;
  if (item.custo !== null) soma.custo = (soma.custo || 0) + item.custo;
  for (const campo of CAMPOS_TEXTO) soma[campo] = soma[campo] || item[campo];
}

function fecharSomas(somas) {
  const registros = [...somas.values()];
  for (const r of registros) {
    if (r.custo !== null) r.custo = conferirTotal(r.custo);
    if (r.visitas > 100000) throw new ErroDeImportacao('Quantidade de visitas grande demais. Confira a coluna de visitas.');
  }
  return registros;
}

const chaveVisita = (promotorId, lojaId, mes) => `${promotorId}|${lojaId}|${mes}`;

// Atendimentos que já existem no sistema com o mesmo promotor, loja e mês dos registros do arquivo.
async function visitasQueJaExistem(rodar, registros) {
  const atuais = new Map();
  const comIds = registros.filter((r) => r.promotorId && r.lojaId);
  for (let i = 0; i < comIds.length; i += LOTE) {
    const lote = comIds.slice(i, i + LOTE);
    const linhas = await rodar(
      `SELECT v.* FROM visitas v JOIN unnest($1::int[], $2::int[], $3::text[]) AS k(promotor_id, loja_id, mes)
         ON v.promotor_id = k.promotor_id AND v.loja_id = k.loja_id AND v.mes = k.mes`,
      [lote.map((r) => r.promotorId), lote.map((r) => r.lojaId), lote.map((r) => r.mes)],
    );
    for (const l of linhas) atuais.set(chaveVisita(l.promotor_id, l.loja_id, l.mes), l);
  }
  return atuais;
}

const visitaIgual = (atual, r) => atual.qtd_visitas === r.visitas && mesmoValor(atual.custo, r.custo)
  && (atual.dias_visita || '') === r.dias && (atual.status || '') === r.status
  && (atual.supervisor || '') === r.supervisor && (atual.observacao || '') === r.observacao;

// "Somar": visitas e valor somados (valor vazio nos dois continua vazio); textos do arquivo, ou os de antes se
// o arquivo não trouxe; supervisores dos dois, sem repetir.
function somarComAtual(atual, r) {
  const nomes = [];
  for (const nome of [...separarSupervisores(atual.supervisor || ''), ...separarSupervisores(r.supervisor)]) {
    if (!nomes.some((n) => normalizar(n) === normalizar(nome))) nomes.push(nome);
  }
  return {
    ...r,
    visitas: atual.qtd_visitas + r.visitas,
    custo: atual.custo === null && r.custo === null ? null : conferirTotal(Number(atual.custo || 0) + (r.custo || 0)),
    dias: r.dias || atual.dias_visita || '',
    status: r.status || atual.status || '',
    observacao: r.observacao || atual.observacao || '',
    supervisor: nomes.join(', '),
  };
}

// Separa os registros do arquivo em novos, iguais e diferentes (comparando com o que já existe).
function compararVisitas(registros, atuais) {
  const grupos = { novos: [], iguais: [], diferentes: [] };
  for (const r of registros) {
    const atual = r.promotorId && r.lojaId ? atuais.get(chaveVisita(r.promotorId, r.lojaId, r.mes)) : null;
    if (!atual) grupos.novos.push(r);
    else if (visitaIgual(atual, r)) grupos.iguais.push({ r, atual });
    else grupos.diferentes.push({ r, atual });
  }
  return grupos;
}

async function gravarVisitas(dados, usuario) {
  const { registro, itens, modo } = prepararVisitas(dados);

  return transacao(async (rodar) => {
    const contagem = { lojasNovas: 0, promotoresNovos: 0 };
    const lojas = await resolverLojas(rodar, itens, contagem);
    const importacaoId = await registrarImportacao(rodar, 'visitas', dados.arquivo, usuario);
    const cadastro = await carregarPromotores(rodar);

    // Promotor de cada item: o que já existe ou um novo. Conta quem veio com código e não achou cadastro.
    const codigosSemCadastro = new Set();
    const naoIdentificados = new Set();
    const promotores = new Map();
    const acharPromotor = async (p) => {
      const chave = p.id ? `id:${p.id}` : `${codigoNormal(p.codigo)}|${p.nome.toLowerCase()}|${p.agencia.toLowerCase()}`;
      if (promotores.has(chave)) return promotores.get(chave);
      let id;
      if (p.id) {
        if (!cadastro.porId.has(p.id)) throw new ErroDeImportacao('O promotor escolhido não existe mais.');
        id = p.id;
      } else {
        const { promotor: existente, motivo } = cadastro.identificar(p);
        if (p.codigo && !(existente && existente.cadastrado)) codigosSemCadastro.add(`${codigoNormal(p.codigo)}|${primeiroNome(p.nome)}`);
        if (existente && existente.pendente) naoIdentificados.add(existente.id);
        if (existente) {
          id = existente.id;
          // Promotor que veio só do cadastro (sem agência): passa a ter a agência da planilha de atendimentos.
          if (!existente.agencia && p.agencia) {
            await rodar('UPDATE promotores SET agencia = $1 WHERE id = $2', [p.agencia, id]);
            existente.agencia = p.agencia;
          }
        } else {
          // Não identificado. Fica "pendente" (aparece no aviso e pode ser ligado à mão na tela) quando:
          //  - há mais de um parecido no cadastro (não adivinhamos), ou
          //  - é CLT e não está no cadastro (CLT deveria estar; sem cadastro não há salário).
          // Promotor de agência, MEI ou freelancer que não existe ainda é só um promotor novo.
          const pendente = motivo === 'ambiguo' || p.tipo === 'CLT' ? motivo : '';
          const [criado] = await rodar('INSERT INTO promotores (nome, tipo, agencia, codigo, pendente) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [p.nome, p.tipo, p.agencia, p.codigo, pendente]);
          cadastro.incluir(criado);
          id = criado.id;
          if (pendente) naoIdentificados.add(id);
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
      acumularVisita(somas, chaveVisita(promotorId, lojaId, item.mes), { promotorId, lojaId }, item);
    }
    const registros = fecharSomas(somas);

    // O que já existe: cópia para o Desfazer, e separa em iguais e diferentes.
    const atuais = await visitasQueJaExistem(rodar, registros);
    await guardarCopia(rodar, importacaoId, 'visitas', [...atuais.values()]);
    const grupos = compararVisitas(registros, atuais);
    const diferentes = grupos.diferentes.map(({ r, atual }) => ({ atual, r: modo === 'somar' ? somarComAtual(atual, r) : r }));

    // 1) Novos: entram.
    const gravadas = [];
    for (let i = 0; i < grupos.novos.length; i += LOTE) {
      const lote = grupos.novos.slice(i, i + LOTE);
      gravadas.push(...await rodar(
        `INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita, status, supervisor, observacao, importacao_id)
         SELECT promotor_id, loja_id, mes, qtd, custo, dias, status, supervisor, observacao, $10::int
         FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::numeric[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS t(promotor_id, loja_id, mes, qtd, custo, dias, status, supervisor, observacao)
         RETURNING id, supervisor`,
        [lote.map((r) => r.promotorId), lote.map((r) => r.lojaId), lote.map((r) => r.mes), lote.map((r) => r.visitas), lote.map((r) => r.custo),
          lote.map((r) => r.dias), lote.map((r) => r.status), lote.map((r) => r.supervisor), lote.map((r) => r.observacao), importacaoId],
      ));
    }
    // 2) Já existiam: os iguais ficam com os mesmos valores e os diferentes recebem os novos (substituídos ou somados).
    //    Todos passam a ser desta importação, para o Desfazer saber o que voltar.
    const atualizar = [
      ...grupos.iguais.map(({ atual }) => ({ id: atual.id, visitas: atual.qtd_visitas, custo: atual.custo === null ? null : Number(atual.custo),
        dias: atual.dias_visita || '', status: atual.status || '', supervisor: atual.supervisor || '', observacao: atual.observacao || '' })),
      ...diferentes.map(({ r, atual }) => ({ ...r, id: atual.id })),
    ];
    for (let i = 0; i < atualizar.length; i += LOTE) {
      const lote = atualizar.slice(i, i + LOTE);
      await rodar(
        `UPDATE visitas v SET qtd_visitas = t.qtd, custo = t.custo, dias_visita = t.dias, status = t.status, supervisor = t.supervisor,
           observacao = t.observacao, importacao_id = $8::int
         FROM unnest($1::int[], $2::int[], $3::numeric[], $4::text[], $5::text[], $6::text[], $7::text[])
           AS t(id, qtd, custo, dias, status, supervisor, observacao)
         WHERE v.id = t.id`,
        [lote.map((r) => r.id), lote.map((r) => r.visitas), lote.map((r) => r.custo), lote.map((r) => r.dias), lote.map((r) => r.status),
          lote.map((r) => r.supervisor), lote.map((r) => r.observacao), importacaoId],
      );
    }
    // 3) Supervisores: os diferentes perdem os vínculos antigos e ganham os do texto novo; os novos ganham os seus.
    const idsDiferentes = diferentes.map(({ atual }) => atual.id);
    if (idsDiferentes.length) await rodar('DELETE FROM visita_supervisor WHERE visita_id = ANY($1::int[])', [idsDiferentes]);
    const supervisao = await ligarAtendimentos(rodar, [
      ...gravadas.map((v) => ({ visitaId: v.id, texto: v.supervisor })),
      ...diferentes.map(({ r, atual }) => ({ visitaId: atual.id, texto: r.supervisor })),
    ]);

    if (codigosSemCadastro.size) registro.avisos['Promotor com código que não está no cadastro (sem salário para calcular o custo)'] = codigosSemCadastro.size;
    if (naoIdentificados.size) registro.avisos['Promotor não identificado (ligue à mão na tela Promotores)'] = naoIdentificados.size;
    const resultado = montarResultado(registros, registro, {
      ...contagem, modo, novos: grupos.novos.length, iguais: grupos.iguais.length,
      substituidas: modo === 'substituir' ? diferentes.length : 0, somadas: modo === 'somar' ? diferentes.length : 0,
      vinculosSupervisor: supervisao.vinculos, supervisoresCriados: supervisao.criados, supervisoresPorPrimeiroNome: supervisao.porPrimeiroNome,
    }, 'custo');
    await fecharImportacao(rodar, importacaoId, resultado);
    return resultado;
  });
}

// ---------- Prévia: o que a importação vai fazer ----------
// Chamada antes de gravar, com os mesmos dados. Não grava nada. Devolve a mensagem para a pessoa confirmar:
// por mês, quantos registros são novos, quantos já existem (iguais ou diferentes) e exemplos dos diferentes.
const MAX_EXEMPLOS = 8;
const formatoReais = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const reais = (valor) => (valor === null || valor === undefined ? 'sem valor' : formatoReais.format(Number(valor)));
const cnpjFormatado = (c) => (c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c);
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function linhaDaPrevia(rotulo, grupos, nome) {
  const existem = grupos.iguais.length + grupos.diferentes.length;
  const partes = [`${rotulo}: ${plural(grupos.novos.length, `${nome.um} novo`, `${nome.varios} novos`)}`];
  if (existem) {
    const detalhe = [grupos.iguais.length && plural(grupos.iguais.length, 'igual', 'iguais'), grupos.diferentes.length && `${grupos.diferentes.length} com valores diferentes`]
      .filter(Boolean).join(', ');
    partes.push(`${existem} já ${existem === 1 ? 'existe' : 'existem'} no sistema (${detalhe})`);
  }
  return `${partes.join(' · ')}.`;
}

async function previaDoFaturamento(dados) {
  const { registros } = prepararFaturamento(dados);
  const grupos = compararFaturamento(registros, await faturamentoQueJaExiste(consulta, registros));
  const pares = [...new Set(registros.map((r) => `${r.mes}|${r.empresa}`))].sort();
  const doPar = (lista, par) => lista.filter((r) => `${r.mes}|${r.empresa}` === par);
  const linhas = pares.map((par) => {
    const [mes, empresa] = par.split('|');
    const g = { novos: doPar(grupos.novos, par), iguais: doPar(grupos.iguais, par), diferentes: doPar(grupos.diferentes, par) };
    return { mes, empresa, novos: g.novos.length, iguais: g.iguais.length, diferentes: g.diferentes.length,
      texto: linhaDaPrevia(`${rotuloMes(mes)}${empresa ? ` (empresa ${empresa})` : ''}`, g, { um: 'CNPJ', varios: 'CNPJs' }) };
  });
  const exemplos = grupos.diferentes.slice(0, MAX_EXEMPLOS)
    .map((r) => `${r.nome || 'Cliente'} (${cnpjFormatado(r.cnpj)}) ${rotuloMes(r.mes)}: no sistema ${reais(r.antes)} → no arquivo ${reais(r.valor)}`);
  const mensagem = [
    ...linhas.map((l) => l.texto),
    'Nada será apagado: o que já está no sistema e não veio no arquivo continua.',
    ...(grupos.diferentes.length ? [`${grupos.diferentes.length === 1 ? 'O que tem valor diferente fica' : `Os ${grupos.diferentes.length} com valor diferente ficam`} com o valor do arquivo:`, ...exemplos] : []),
  ].join('\n');
  return { linhas, mensagem, diferentes: grupos.diferentes.length, permiteSomar: false };
}

async function previaDasVisitas(dados) {
  const { itens } = prepararVisitas(dados);
  const cadastro = await carregarPromotores(consulta);
  const chaves = [...new Set(itens.map((i) => i.loja.chave))];
  const lojasPorChave = new Map((await consulta('SELECT id, chave, nome FROM lojas WHERE chave = ANY($1::text[])', [chaves])).map((l) => [l.chave, l]));
  // Agrupa como a gravação. Promotor ou loja que ainda não existe = atendimento novo, com certeza.
  const somas = new Map();
  for (const item of itens) {
    const p = item.promotor;
    const promotor = p.id ? cadastro.porId.get(p.id) || null : cadastro.identificar(p).promotor;
    const loja = lojasPorChave.get(item.loja.chave) || null;
    const chave = promotor && loja ? chaveVisita(promotor.id, loja.id, item.mes)
      : `novo|${p.id || ''}|${codigoNormal(p.codigo || '')}|${(p.nome || '').toLowerCase()}|${(p.agencia || '').toLowerCase()}|${item.loja.chave}|${item.mes}`;
    acumularVisita(somas, chave, {
      promotorId: promotor && loja ? promotor.id : null, lojaId: promotor && loja ? loja.id : null,
      promotorNome: (promotor && promotor.nome) || p.nome || '', lojaNome: item.loja.nome,
    }, item);
  }
  const registros = fecharSomas(somas);
  const grupos = compararVisitas(registros, await visitasQueJaExistem(consulta, registros));
  const meses = [...new Set(registros.map((r) => r.mes))].sort();
  const doMes = (lista, mes) => lista.filter((x) => (x.r || x).mes === mes);
  const linhas = meses.map((mes) => {
    const g = { novos: doMes(grupos.novos, mes), iguais: doMes(grupos.iguais, mes), diferentes: doMes(grupos.diferentes, mes) };
    return { mes, novos: g.novos.length, iguais: g.iguais.length, diferentes: g.diferentes.length,
      texto: linhaDaPrevia(rotuloMes(mes), g, { um: 'atendimento', varios: 'atendimentos' }) };
  });
  const visitasTexto = (n) => plural(n, 'visita', 'visitas');
  const exemplos = grupos.diferentes.slice(0, MAX_EXEMPLOS).map(({ r, atual }) => `${r.promotorNome} – ${r.lojaNome} (${rotuloMes(r.mes)}): `
    + `no sistema ${visitasTexto(atual.qtd_visitas)} / ${reais(atual.custo)} → no arquivo ${visitasTexto(r.visitas)} / ${reais(r.custo)}`);
  const mensagem = [
    ...linhas.map((l) => l.texto),
    'Nada será apagado: o que já está no sistema e não veio no arquivo continua (inclusive o lançado à mão).',
    ...(grupos.diferentes.length ? [grupos.diferentes.length === 1 ? 'O que tem valores diferentes:' : `Exemplos dos ${grupos.diferentes.length} com valores diferentes:`, ...exemplos] : []),
  ].join('\n');
  return { linhas, mensagem, diferentes: grupos.diferentes.length, permiteSomar: grupos.diferentes.length > 0 };
}

async function previaDaImportacao(dados) {
  const tipo = dados && dados.tipo;
  if (tipo === 'faturamento') return previaDoFaturamento(dados);
  if (tipo === 'visitas') return previaDasVisitas(dados);
  if (tipo === 'promotores') {
    const { itens: todos } = prepararPromotores(dados);
    const itens = todos.filter((p) => !ehSupervisor(p.cargo));
    const supervisores = todos.length - itens.length;
    const cadastro = await carregarPromotores(consulta);
    const grupos = { atualizar: [], criar: [], ambiguos: [] };
    for (const p of itens) {
      const { promotor, ambiguo } = cadastro.achar(p);
      if (ambiguo) grupos.ambiguos.push(p.nome);
      else if (promotor) grupos.atualizar.push(promotor.nome === p.nome ? p.nome : `${p.nome} → ${promotor.nome}`);
      else grupos.criar.push(p.nome);
    }
    const lista = (nomes) => (nomes.length > 30 ? `${nomes.slice(0, 30).join(', ')} e mais ${nomes.length - 30}` : nomes.join(', '));
    const mensagem = [
      `Vai atualizar ${grupos.atualizar.length} promotor(es) que já existem: o que vier preenchido no arquivo substitui; o que vier vazio mantém o valor do sistema.`,
      ...(grupos.atualizar.length ? [`Atualizados: ${lista(grupos.atualizar)}.`] : []),
      `Vai criar ${grupos.criar.length} promotor(es) novo(s)${grupos.criar.length ? `: ${lista(grupos.criar)}` : ''}. Confira se algum já existe com outro nome (evita duplicado).`,
      ...(grupos.ambiguos.length ? [`Não vai mexer em ${grupos.ambiguos.length} (mais de um com o mesmo nome no sistema e sem código): ${lista(grupos.ambiguos)}.`] : []),
      ...(supervisores ? [`${supervisores} supervisor(es) vão para o cadastro de supervisores (sem salário nem custo).`] : []),
      'Promotores pendentes que forem a mesma pessoa serão ligados automaticamente. A importação do cadastro não pode ser desfeita.',
    ].join('\n');
    return { linhas: [], mensagem, ...grupos };
  }
  throw new ErroDeImportacao('Tipo de importação inválido.');
}

// ---------- Desfazer ----------
// Desfazer apaga o que a importação gravou (o que entrou e o que ela substituiu ou somou) e volta, da cópia,
// as linhas que já existiam antes dela.
// Não dá para desfazer se uma importação MAIS NOVA já mexeu nessas mesmas linhas (a cópia dela guarda linhas
// desta importação): desfazer agora voltaria dados por cima do que a mais nova gravou.
// Assim, importar a agência A e depois a agência B no mesmo mês não impede desfazer a A.
async function importacoesJaAlteradas(rodar) {
  const linhas = await rodar(`SELECT DISTINCT (e ->> 'importacao_id')::int AS id
    FROM importacoes_backup b CROSS JOIN LATERAL jsonb_array_elements(b.dados) AS e
    WHERE jsonb_typeof(b.dados) = 'array' AND e ->> 'importacao_id' IS NOT NULL`);
  return new Set(linhas.map((l) => l.id));
}

function motivoParaNaoDesfazer(imp, jaAlteradas) {
  if (imp.tipo === 'promotores') return 'A importação do cadastro de promotores não pode ser desfeita. Corrija o promotor na tela ou importe o cadastro de novo.';
  if (jaAlteradas.has(imp.id)) return 'Uma importação mais nova já alterou dados desta. Desfaça antes a mais nova.';
  return '';
}

async function listarImportacoes() {
  const [todas, jaAlteradas] = await Promise.all([consulta('SELECT * FROM importacoes ORDER BY id DESC LIMIT 30'), importacoesJaAlteradas(consulta)]);
  return todas.map((imp) => {
    const motivo = motivoParaNaoDesfazer(imp, jaAlteradas);
    return { ...imp, podeDesfazer: !motivo, motivoNaoDesfaz: motivo };
  });
}

class NaoEncontrado extends Error {}

// Apaga o que a importação gravou e restaura o que ela tinha substituído, numa transação só.
// Importação antiga (sem cópia): o dado anterior não volta, então só apaga se a pessoa digitar "APAGAR".
async function desfazerImportacao(id, confirmacao = '') {
  return transacao(async (rodar) => {
    const [imp] = await rodar('SELECT * FROM importacoes WHERE id = $1 FOR UPDATE', [id]);
    if (!imp) throw new NaoEncontrado('Importação não encontrada.');
    if (!imp.restauravel && imp.tipo !== 'promotores' && confirmacao !== 'APAGAR') {
      throw new ErroDeImportacao('Esta importação é de antes da cópia de segurança: desfazer só apaga, e o dado anterior não volta. Para apagar mesmo assim, digite APAGAR.');
    }
    const motivo = motivoParaNaoDesfazer(imp, await importacoesJaAlteradas(rodar));
    if (motivo) throw new ErroDeImportacao(motivo);
    const tabela = { faturamento: 'faturamento_erp', visitas: 'visitas' }[imp.tipo];
    const apagados = await rodar(`DELETE FROM ${tabela} WHERE importacao_id = $1 RETURNING 1`, [id]);
    const [copia] = await rodar('SELECT dados FROM importacoes_backup WHERE importacao_id = $1 AND tabela = $2', [id, tabela]);
    let restaurados = [];
    if (copia) {
      // A importação de origem das linhas restauradas pode ter sido apagada: nesse caso fica sem origem.
      restaurados = imp.tipo === 'faturamento'
        ? await rodar(
          `INSERT INTO faturamento_erp (cnpj, mes, empresa, valor, importacao_id)
           SELECT r.cnpj, r.mes, r.empresa, r.valor, (SELECT i.id FROM importacoes i WHERE i.id = r.importacao_id)
           FROM jsonb_to_recordset($1::jsonb) AS r(cnpj text, mes text, empresa text, valor numeric, importacao_id int)
           ON CONFLICT DO NOTHING RETURNING 1`, [JSON.stringify(copia.dados)])
        : await rodar(
          `INSERT INTO visitas (id, promotor_id, loja_id, mes, qtd_visitas, custo, dias_visita, status, supervisor, observacao, importacao_id)
           SELECT r.id, r.promotor_id, r.loja_id, r.mes, r.qtd_visitas, r.custo, coalesce(r.dias_visita, ''), coalesce(r.status, ''),
                  coalesce(r.supervisor, ''), coalesce(r.observacao, ''), (SELECT i.id FROM importacoes i WHERE i.id = r.importacao_id)
           FROM jsonb_to_recordset($1::jsonb) AS r(id int, promotor_id int, loja_id int, mes text, qtd_visitas int, custo numeric,
                dias_visita text, status text, supervisor text, observacao text, importacao_id int)
           WHERE EXISTS (SELECT 1 FROM promotores p WHERE p.id = r.promotor_id) AND EXISTS (SELECT 1 FROM lojas l WHERE l.id = r.loja_id)
           ON CONFLICT DO NOTHING RETURNING id, supervisor`, [JSON.stringify(copia.dados)]);
      // Os vínculos com os supervisores voltam a partir do texto original guardado em visitas.supervisor.
      if (imp.tipo === 'visitas') await ligarAtendimentos(rodar, restaurados.map((v) => ({ visitaId: v.id, texto: v.supervisor })));
    }
    await rodar('DELETE FROM importacoes WHERE id = $1', [id]); // a cópia vai junto (ON DELETE CASCADE)
    return { registros: apagados.length, restaurados: restaurados.length, semCopia: !imp.restauravel };
  });
}

module.exports = {
  gravarFaturamento, gravarVisitas, gravarPromotores, gravarSupervisor, previaDaImportacao, listarImportacoes, desfazerImportacao,
  ErroDeImportacao, NaoEncontrado,
};
