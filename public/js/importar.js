// Tela Importar. O arquivo é lido AQUI NO NAVEGADOR, aos poucos, porque o relatório do FoccoERP
// pode passar de 150 MB. O navegador soma as linhas por loja e mês e envia ao servidor só o resultado.
// As regras de leitura ficam em planilha-comum.js (objeto "Planilha").
const el = (id) => document.getElementById(id);

// O que sabemos do arquivo escolhido:
//   formato: 'html' (o .xls do Focco), 'csv' ou 'xlsx'
//   abas:    só no .xlsx (o servidor converte e devolve as linhas)
//   analise: cabeçalho, colunas sugeridas e amostra
let estado = null;

const AJUDA = {
  faturamento: 'Use o arquivo .xls do Gerador de Relatórios do FoccoERP, de preferência com o mês inteiro. O sistema soma as notas de cada cliente (CNPJ) por mês.',
  visitas: 'Aba "Atendimentos" do modelo padrão (uma linha por loja atendida no mês), ou a planilha de uma agência. Se o arquivo não disser de quem é, você escolhe abaixo.',
  promotores: 'Aba "Promotores CLT" do modelo padrão: nome, código, salário e adicionais. Quem já está cadastrado tem os valores atualizados.',
};
const SUBSTITUI = {
  faturamento: 'Atenção: se já existir faturamento da mesma loja, mês e empresa, o valor deste arquivo substitui o anterior (não soma).',
  visitas: 'Atenção: se já existirem atendimentos do mesmo promotor, loja e mês, os deste arquivo substituem os anteriores (não somam).',
  promotores: 'Atenção: para quem já está cadastrado, o salário e os demais valores passam a ser os deste arquivo.',
};

const tamanho = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function progresso(texto) {
  el('progresso').textContent = texto;
  el('progresso').hidden = !texto;
}

// Descobre o formato olhando o começo do conteúdo (a extensão engana: o ".xls" do Focco é HTML).
async function descobrirFormato(arquivo) {
  const inicio = new Uint8Array(await arquivo.slice(0, 4096).arrayBuffer());
  if (inicio[0] === 0x50 && inicio[1] === 0x4b) return 'xlsx'; // todo .xlsx começa com "PK"
  if (inicio[0] === 0xd0 && inicio[1] === 0xcf) {
    throw new Error('Este .xls é do Excel antigo (binário). Abra no Excel e use "Salvar como" → .xlsx ou .csv.');
  }
  const texto = new TextDecoder('windows-1252').decode(inicio).toLowerCase();
  return /<html|<table|<!doctype/.test(texto) ? 'html' : 'csv';
}

// Lê um arquivo de texto (html ou csv) pedaço por pedaço e entrega as linhas para "aoLerLinhas".
// Se "aoLerLinhas" devolver false, a leitura para (usado para pegar só o começo do arquivo).
// "criarConsumidor" é chamado a cada tentativa: tentamos UTF-8 e, se o arquivo não for UTF-8
// (o Focco grava no padrão antigo do Windows), começamos de novo com windows-1252.
async function percorrerArquivo(arquivo, formato, criarConsumidor, aoProgredir) {
  for (const codificacao of ['utf-8', 'windows-1252']) {
    const aoLerLinhas = criarConsumidor();
    const decodificador = new TextDecoder(codificacao, { fatal: codificacao === 'utf-8' });
    const leitorDeLinhas = Planilha.criarLeitor(formato);
    const leitorDoArquivo = arquivo.stream().getReader();
    let lidos = 0;
    try {
      for (;;) {
        const { done, value } = await leitorDoArquivo.read();
        if (done) break;
        lidos += value.length;
        const continuar = aoLerLinhas(leitorDeLinhas.receber(decodificador.decode(value, { stream: true })));
        if (aoProgredir) aoProgredir(lidos / arquivo.size);
        if (continuar === false) { await leitorDoArquivo.cancel(); return; }
      }
      aoLerLinhas([...leitorDeLinhas.receber(decodificador.decode()), ...leitorDeLinhas.terminar()]);
      return;
    } catch (erro) {
      await leitorDoArquivo.cancel().catch(() => {});
      // TypeError aqui = o texto não é UTF-8 válido. Tenta de novo na outra codificação.
      if (!(erro instanceof TypeError) || codificacao !== 'utf-8') throw erro;
    }
  }
}

// As primeiras linhas do arquivo (para achar o cabeçalho e montar a amostra).
async function primeirasLinhas(arquivo, formato, quantidade = 200) {
  let linhas = [];
  await percorrerArquivo(arquivo, formato, () => {
    linhas = [];
    return (novas) => { linhas.push(...novas); return linhas.length < quantidade; };
  });
  return linhas;
}

function mapaEscolhido() {
  const mapa = {};
  for (const seletor of document.querySelectorAll('#mapa select')) if (seletor.value !== '') mapa[seletor.dataset.campo] = Number(seletor.value);
  return mapa;
}

// Mostra só os campos extras que fazem sentido para o tipo e para as colunas escolhidas.
function ajustarExtras() {
  const tipo = el('tipo').value;
  const mapa = mapaEscolhido();
  // Precisa escolher o promotor na tela só quando o arquivo não tem nem a coluna do promotor nem a da agência.
  const escolherPromotor = tipo === 'visitas' && mapa.promotor === undefined && mapa.agencia === undefined;
  const cadastrarNovo = escolherPromotor && el('promotor').value === 'novo';
  for (const campo of document.querySelectorAll('[data-so]')) campo.hidden = campo.dataset.so !== tipo;
  el('campo-mes').hidden = tipo === 'promotores';
  el('campo-promotor').hidden = !escolherPromotor;
  for (const campo of document.querySelectorAll('[data-novo]')) campo.hidden = true;
  el('novo-nome').closest('.campo').hidden = !cadastrarNovo;
  el('novo-agencia').closest('.campo').hidden = !cadastrarNovo;
  // O tipo serve para o promotor novo, ou como padrão quando a planilha não tem a coluna Tipo.
  el('novo-tipo').closest('.campo').hidden = !(cadastrarNovo || (tipo !== 'faturamento' && !escolherPromotor && mapa.tipo === undefined));
  document.querySelector('label[for="novo-tipo"]').textContent = cadastrarNovo ? 'Tipo' : 'Tipo dos promotores (a planilha não tem essa coluna)';
  if (tipo === 'promotores' && mapa.tipo === undefined && !el('novo-tipo').dataset.mexido) el('novo-tipo').value = 'CLT';
  el('titulo-extras').hidden = ![...document.querySelectorAll('#extras > .campo')].some((campo) => !campo.hidden);
}

function mostrarConferencia() {
  const { analise, abas, arquivo } = estado;
  const opcoesColunas = analise.colunas.map((nome, i) => `<option value="${i}">${esc(nome || `Coluna ${i + 1}`)}</option>`).join('');
  el('mapa').innerHTML = analise.campos.map(({ campo, rotulo }) => `
    <div class="campo"><label for="m-${campo}">${esc(rotulo)}</label>
      <select id="m-${campo}" data-campo="${campo}"><option value="">— não tem no arquivo —</option>${opcoesColunas}</select></div>`).join('');
  for (const [campo, coluna] of Object.entries(analise.mapa)) el(`m-${campo}`).value = coluna;
  el('aba-linha').hidden = !abas || abas.length < 2;
  if (abas) {
    el('aba').innerHTML = abas.map((a) => `<option>${esc(a.nome)}</option>`).join('');
    el('aba').value = estado.aba.nome;
  }
  el('amostra').innerHTML = `
    <thead><tr>${analise.colunas.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${analise.amostra.map((l) => `<tr>${analise.colunas.map((_, i) => `<td>${esc(l[i] ?? '')}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${analise.colunas.length || 1}" class="vazio">O arquivo só tem o cabeçalho, sem linhas de dados.</td></tr>`}</tbody>`;
  el('substitui').textContent = `Arquivo de ${tamanho(arquivo.size)}. ${SUBSTITUI[el('tipo').value]}`;
  ajustarExtras();
  el('conferencia').hidden = false;
}

// Passo 1: a pessoa escolheu o arquivo (ou trocou o tipo/aba). Lê o começo e mostra as colunas.
async function analisar(nomeAba) {
  const aviso = el('aviso');
  mostrarAviso(aviso, '');
  el('conferencia').hidden = true;
  const arquivo = el('arquivo').files[0];
  if (!arquivo) { estado = null; return; }
  try {
    progresso('Abrindo o arquivo…');
    // Se só trocou o tipo ou a aba, não precisa ler o arquivo de novo.
    if (!estado || estado.arquivo !== arquivo) {
      const formato = await descobrirFormato(arquivo);
      estado = { arquivo, formato };
      if (formato === 'xlsx') {
        const resposta = await api('/api/importar/converter', { method: 'POST', body: arquivo, headers: { 'Content-Type': 'application/octet-stream' } });
        estado.abas = resposta.abas;
      } else {
        estado.inicio = await primeirasLinhas(arquivo, formato);
      }
    }
    const tipo = el('tipo').value;
    if (estado.abas) {
      // Planilha com várias abas: usa a que a pessoa escolheu ou, se não escolheu, a que tem mais colunas reconhecidas.
      const melhor = (abas) => abas.reduce((a, b) => (Planilha.analisar(b.linhas, tipo).acertos > Planilha.analisar(a.linhas, tipo).acertos ? b : a));
      estado.aba = estado.abas.find((a) => a.nome === nomeAba) || melhor(estado.abas);
    }
    estado.analise = Planilha.analisar(estado.abas ? estado.aba.linhas : estado.inicio, tipo);
    if (!estado.analise.colunas.length) throw new Error('Não encontrei nenhuma tabela dentro do arquivo.');
    mostrarConferencia();
  } catch (erro) {
    estado = null;
    mostrarAviso(aviso, erro.message);
  } finally {
    progresso('');
  }
}

// O que a pessoa informou na tela e não está no arquivo (mês, empresa, promotor).
function opcoesDaTela(tipo, mapa) {
  if (tipo === 'promotores') return { promotorNovo: { tipo: el('novo-tipo').value } };
  const opcoes = { mes: el('mes').value };
  if (mapa.data === undefined && !opcoes.mes) throw new Error('Escolha o mês das informações (o arquivo não tem coluna de data).');
  if (tipo === 'faturamento') {
    opcoes.empresa = el('empresa').value.trim();
    return opcoes;
  }
  opcoes.promotorNovo = { tipo: el('novo-tipo').value, agencia: el('novo-agencia').value.trim() };
  if (mapa.promotor === undefined && mapa.agencia === undefined) {
    if (el('promotor').value === 'novo') {
      opcoes.promotorNovo.nome = el('novo-nome').value.trim();
      if (!opcoes.promotorNovo.nome) throw new Error('Informe o nome do novo promotor ou agência.');
    } else if (el('promotor').value) opcoes.promotorId = Number(el('promotor').value);
    else throw new Error('Escolha de qual promotor ou agência é este arquivo.');
  }
  return opcoes;
}

// Passo 2: lê o arquivo inteiro somando as linhas, e envia o resultado para o servidor gravar.
async function confirmar() {
  const aviso = el('aviso');
  const tipo = el('tipo').value;
  mostrarAviso(aviso, '');
  try {
    const mapa = mapaEscolhido();
    const opcoes = opcoesDaTela(tipo, mapa);
    el('confirmar').disabled = true;
    const { arquivo, formato, analise } = estado;
    let agrupador;

    if (formato === 'xlsx') {
      agrupador = Planilha.criarAgrupador(tipo, mapa, opcoes);
      estado.aba.linhas.slice(analise.linhaCabecalho + 1).forEach(agrupador.adicionar);
    } else {
      await percorrerArquivo(arquivo, formato, () => {
        agrupador = Planilha.criarAgrupador(tipo, mapa, opcoes);
        let numero = 0; // posição da linha no arquivo, para pular o título e o cabeçalho
        return (linhas) => { for (const linha of linhas) if (numero++ > analise.linhaCabecalho) agrupador.adicionar(linha); };
      }, (fracao) => progresso(`Lendo o arquivo… ${Math.round(fracao * 100)}%`));
    }

    const { itens, motivos, avisos } = agrupador.resultado();
    if (!itens.length) throw new Error(`Nenhuma linha válida no arquivo. ${Object.keys(motivos).join('; ')}`);
    progresso(`Gravando ${itens.length} registro(s)…`);
    const r = await api('/api/importar/gravar', { method: 'POST', json: { tipo, arquivo: arquivo.name, itens, motivos, avisos } });

    const lista = (contagens) => Object.entries(contagens).map(([frase, n]) => `${frase} (${n})`).join('; ');
    const partes = [tipo === 'promotores'
      ? `Importação concluída: ${r.importadas} promotor(es), custo mensal somado de ${reais(r.total)}.`
      : `Importação concluída: ${r.importadas} registro(s), total ${reais(r.total)}, mês(es) ${r.meses.map(rotuloMes).join(', ')}.`];
    if (r.lojasNovas) partes.push(`${r.lojasNovas} loja(s) nova(s) cadastrada(s).`);
    if (r.clientesNovos) partes.push(`${r.clientesNovos} CNPJ(s) novo(s) no faturamento do ERP.`);
    if (r.promotoresNovos) partes.push(`${r.promotoresNovos} promotor(es) novo(s) cadastrado(s).`);
    if (r.promotoresAtualizados) partes.push(`${r.promotoresAtualizados} promotor(es) atualizado(s).`);
    if (r.ignoradas) partes.push(`${r.ignoradas} linha(s) ignorada(s): ${lista(r.motivos)}.`);
    if (Object.keys(r.avisos || {}).length) partes.push(`Para conferir: ${lista(r.avisos)}.`);
    mostrarAviso(aviso, partes.join(' '), 'ok');
    el('conferencia').hidden = true;
    el('arquivo').value = '';
    estado = null;
    // Os dados mudaram: apaga o que a aba lembrava, para as outras telas buscarem tudo de novo.
    const eu = guardado('eu');
    esquecerTudo();
    if (eu) guardar('eu', eu);
    await carregarListas();
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  } finally {
    el('confirmar').disabled = false;
    progresso('');
  }
  aviso.scrollIntoView({ block: 'center' });
}

async function carregarListas() {
  const [opcoes, promotores, historico] = await Promise.all([api('/api/opcoes'), api('/api/promotores-nomes'), api('/api/importacoes')]);
  el('promotor').innerHTML = `<option value="">Escolha…</option>${promotores.map((p) => `<option value="${p.id}">${esc(p.nome)} (${esc(TIPOS[p.tipo])}${p.agencia && p.agencia !== p.nome ? ` · ${esc(p.agencia)}` : ''})</option>`).join('')}<option value="novo">+ Cadastrar novo promotor ou agência</option>`;
  el('lista-empresas').innerHTML = opcoes.empresas.map((e) => `<option value="${esc(e)}"></option>`).join('');
  // Muitos meses viram "jan/2026 a out/2026" para a coluna não esticar.
  const resumoDosMeses = (texto) => {
    const meses = texto.split(', ').filter(Boolean);
    if (meses.length <= 2) return meses.map(rotuloMes).join(', ');
    return `${rotuloMes(meses[0])} a ${rotuloMes(meses.at(-1))}`;
  };
  el('historico').innerHTML = historico.map((h) => `
    <tr>
      <td>${new Date(h.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}<span class="menor">${esc(h.usuario)}</span></td>
      <td><span class="cortar" title="${esc(h.arquivo)}">${esc(h.arquivo)}</span><span class="menor">${{ faturamento: 'Faturamento', visitas: 'Atendimentos', promotores: 'Cadastro de promotores' }[h.tipo] || esc(h.tipo)}</span></td>
      <td>${esc(resumoDosMeses(h.meses))}</td>
      <td class="num">${h.linhas}</td><td class="num">${h.ignoradas}</td><td class="num">${reais(h.total)}</td>
      <td>${h.tipo === 'promotores' ? '' : `<button type="button" class="perigo pequeno" data-desfazer="${h.id}" data-nome="${esc(h.arquivo)}">Desfazer</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="vazio">Nenhuma importação ainda.</td></tr>';
}

// Desfaz uma importação: apaga do sistema o faturamento ou os atendimentos que vieram daquele arquivo.
async function desfazer(evento) {
  const botao = evento.target.closest('button[data-desfazer]');
  if (!botao) return;
  if (!confirm(`Desfazer a importação de "${botao.dataset.nome}"? Os dados que vieram desse arquivo serão apagados (o que uma importação mais nova substituiu continua).`)) return;
  try {
    const r = await api(`/api/importacoes/${botao.dataset.desfazer}`, { method: 'DELETE' });
    const eu = guardado('eu'); esquecerTudo(); if (eu) guardar('eu', eu); // as listas lembradas ficaram velhas
    mostrarAviso(el('aviso'), `Importação desfeita: ${r.registros} registro(s) apagado(s).`, 'ok');
    await carregarListas();
  } catch (erro) {
    mostrarAviso(el('aviso'), erro.message);
  }
}

(async () => {
  await iniciarPagina();
  el('mes').innerHTML = `<option value="">— escolha —</option>${ultimosMeses().map((m) => `<option value="${m}">${rotuloMes(m)}</option>`).join('')}`;
  await carregarListas();
  el('tipo').addEventListener('change', () => { el('ajuda-tipo').textContent = AJUDA[el('tipo').value]; analisar(); });
  el('arquivo').addEventListener('change', () => analisar());
  el('aba').addEventListener('change', () => analisar(el('aba').value));
  el('mapa').addEventListener('change', ajustarExtras);
  el('promotor').addEventListener('change', ajustarExtras);
  el('novo-tipo').addEventListener('change', () => { el('novo-tipo').dataset.mexido = '1'; });
  el('confirmar').addEventListener('click', confirmar);
  el('historico').addEventListener('click', desfazer);
  el('ajuda-tipo').textContent = AJUDA[el('tipo').value];
})();
