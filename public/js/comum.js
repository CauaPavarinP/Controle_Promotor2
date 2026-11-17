// Funções usadas por todas as telas: chamadas à API, menu, formatação e filtro de período.

// Chama a API e devolve a resposta já convertida. Se o login expirou, volta para a tela de login.
async function api(url, opcoes = {}) {
  if (opcoes.json !== undefined) {
    opcoes.body = JSON.stringify(opcoes.json);
    opcoes.headers = { 'Content-Type': 'application/json' };
  }
  const resposta = await fetch(url, opcoes);
  if (resposta.status === 401 && location.pathname !== '/login') {
    location.href = '/login';
    return new Promise(() => {}); // a página vai trocar; não continua
  }
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro || 'Não foi possível concluir. Tente de novo.');
  return dados;
}

// Evita que um texto vindo do banco seja interpretado como HTML.
function esc(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const formatoReais = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const formatoPct = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Valor desconhecido (null) aparece como "—", e não como R$ 0,00: zero é um número, "—" é "não sabemos".
const reais = (valor) => (valor === null || valor === undefined ? '—' : formatoReais.format(valor));
const pct = (valor) => (valor === null || valor === undefined ? '—' : `${formatoPct.format(valor)}%`);

const NOMES_MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
// "2026-10" -> "out/2026"
function rotuloMes(mes) {
  const [ano, numero] = mes.split('-');
  return `${NOMES_MESES[Number(numero) - 1]}/${ano}`;
}
function cnpjFormatado(cnpj) {
  const c = String(cnpj || '');
  return c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c;
}

const SITUACOES = {
  dentro: 'Dentro da meta', fora: 'Fora da meta', sem_faturamento: 'Sem faturamento', sem_lojas: 'Sem lojas', sem_dados: 'Sem dados',
  sem_promotor: 'Sem promotor', sem_atendimento_no_mes: 'Comprou sem atendimento', custo_nao_informado: 'Custo não informado',
  falta_faturamento: 'Falta o faturamento', sem_cnpj: 'Sem CNPJ',
  vale: 'Vale a pena', nao_vale: 'Não vale a pena', // situações da agência
};
const TIPOS = { CLT: 'CLT', MEI: 'MEI', AGENCIA: 'Agência', FREELANCER: 'Freelancer' };
const etiqueta = (situacao) => `<span class="etiqueta ${esc(situacao)}">${esc(SITUACOES[situacao] || situacao)}</span>`;

function mostrarAviso(elemento, texto, tipo = 'erro') {
  elemento.className = `aviso ${tipo}`;
  elemento.textContent = texto;
  elemento.hidden = !texto;
}

// Guarda pequenas preferências no navegador (ex.: último período escolhido). Se o navegador bloquear, segue sem.
function lembrar(chave, valor) { try { localStorage.setItem(chave, valor); } catch { /* sem armazenamento */ } }
function lembrado(chave) { try { return localStorage.getItem(chave); } catch { return null; } }

// ---------- Memória da aba ----------
// Cada clique no menu abre uma página nova. Para ela não nascer vazia e "piscar", guardamos na memória
// da aba (sessionStorage) a última resposta do servidor: a tela aparece na hora com o que já sabíamos
// e, logo em seguida, confere com o servidor e atualiza se algo mudou.
// Essa memória some ao fechar a aba e é apagada ao sair do sistema.
function guardar(chave, valor) {
  try {
    const texto = JSON.stringify(valor);
    if (texto.length < 1500000) sessionStorage.setItem(`memoria:${chave}`, texto); // respostas enormes não são guardadas
    else sessionStorage.removeItem(`memoria:${chave}`);
  } catch { /* sem armazenamento: o sistema funciona igual, só sem o atalho */ }
}
function guardado(chave) {
  try { return JSON.parse(sessionStorage.getItem(`memoria:${chave}`)); } catch { return null; }
}
function esquecerTudo() {
  try { sessionStorage.clear(); } catch { /* sem armazenamento */ }
}

// Busca uma lista no servidor e manda desenhar. Se já temos a resposta anterior guardada, desenha com ela
// primeiro (na hora) e redesenha quando a resposta nova chegar, se for diferente.
let ultimaBusca = 0;
async function apiComMemoria(url, desenhar) {
  const minhaVez = ++ultimaBusca;
  const antigo = guardado(url);
  if (antigo) desenhar(antigo);
  const novo = await api(url);
  guardar(url, novo);
  // Se a pessoa já mudou o filtro de novo, esta resposta ficou velha: não desenha por cima da mais nova.
  if (minhaVez === ultimaBusca && JSON.stringify(novo) !== JSON.stringify(antigo)) desenhar(novo);
}

function desenharMenu(usuario) {
  const paginas = [
    ['/resumo', 'Resumo'], ['/faturamento', 'Faturamento'], ['/promotores', 'Promotores'], ['/lojas-uf', 'Lojas por UF'],
    ['/agencias', 'Agências'], ['/supervisores', 'Supervisores'], ['/importar', 'Importar'],
  ];
  if (usuario.perfil === 'suporte') paginas.push(['/usuarios', 'Usuários']);
  // A ficha do promotor e a da loja ficam "dentro" de Promotores e de Faturamento no menu.
  const atual = { '/promotor': '/promotores', '/loja': '/faturamento' }[location.pathname] || location.pathname;
  const link = ([endereco, nome]) => `<a href="${endereco}"${endereco === atual ? ' class="ativo" aria-current="page"' : ''}>${nome}</a>`;
  document.getElementById('menu').innerHTML = `
    <div class="marca">Controle de Promotores<small>101 do Brasil</small></div>
    ${paginas.map(link).join('')}
    <div class="rodape">
      <div class="quem">${esc(usuario.nome)}</div>
      ${link(['/conta', 'Minha conta'])}
      <a href="#" id="sair">Sair</a>
    </div>`;
  document.getElementById('sair').addEventListener('click', async (evento) => {
    evento.preventDefault();
    await api('/api/logout', { method: 'POST' });
    esquecerTudo();
    location.href = '/login';
  });
}

// Monta o menu lateral e devolve o usuário logado. Toda tela (menos o login) chama isto primeiro.
// Se já sabemos quem é o usuário, o menu aparece na hora e a conferência com o servidor roda em segundo
// plano (se o login tiver expirado, "api" manda para a tela de login).
async function iniciarPagina() {
  const conhecido = guardado('eu');
  const conferir = api('/api/eu').then((usuario) => {
    if (JSON.stringify(usuario) !== JSON.stringify(conhecido)) { guardar('eu', usuario); desenharMenu(usuario); }
    return usuario;
  });
  if (!conhecido) return conferir;
  desenharMenu(conhecido);
  conferir.catch(() => {});
  return conhecido;
}

// Listas dos filtros (meses com dados, empresas, agências, meta). Usa a resposta guardada, se houver,
// e já busca uma nova para a próxima tela. Depois de uma importação a memória é apagada (ver importar.js).
async function carregarOpcoes() {
  const conhecidas = guardado('opcoes');
  const buscar = api('/api/opcoes').then((opcoes) => { guardar('opcoes', opcoes); return opcoes; });
  if (!conhecidas) return buscar;
  buscar.catch(() => {});
  return conhecidas;
}

// Preenche os dois seletores de período (De / Até) e chama "aoMudar" sempre que o período mudar.
// O período escolhido fica lembrado para as outras telas abrirem no mesmo período.
function montarPeriodo(opcoes, aoMudar) {
  const de = document.getElementById('periodo-de');
  const ate = document.getElementById('periodo-ate');
  const mesAtual = ultimosMeses(1)[0];
  // A lista mostra só os meses que têm algum dado importado (faturamento ou atendimentos).
  // Antes de qualquer importação, mostra o mês atual para a tela não ficar sem opção.
  const meses = opcoes.meses.length ? [...opcoes.meses] : [mesAtual];
  const html = meses.reverse().map((m) => `<option value="${m}">${rotuloMes(m)}</option>`).join('');
  de.innerHTML = html;
  ate.innerHTML = html;
  // Abre no último período usado; se não houver, no mês mais recente que tem faturamento E atendimentos
  // (é o único em que dá para comparar custo com faturamento); se nenhum tiver os dois, no mais recente com dados.
  const completos = opcoes.mesesFaturamento.filter((m) => opcoes.mesesAtendimentos.includes(m));
  const padrao = completos.at(-1) || meses[0]; // "meses" está do mais recente para o mais antigo
  de.value = meses.includes(lembrado('periodo-de')) ? lembrado('periodo-de') : padrao;
  ate.value = meses.includes(lembrado('periodo-ate')) ? lembrado('periodo-ate') : padrao;

  const mudou = (quem) => {
    if (de.value > ate.value) { if (quem === de) ate.value = de.value; else de.value = ate.value; }
    lembrar('periodo-de', de.value);
    lembrar('periodo-ate', ate.value);
    aoMudar();
  };
  de.addEventListener('change', () => mudou(de));
  ate.addEventListener('change', () => mudou(ate));
}

function periodoAtual() {
  return { de: document.getElementById('periodo-de').value, ate: document.getElementById('periodo-ate').value };
}

// Espera a pessoa parar de digitar antes de buscar (evita uma busca a cada tecla).
function comAtraso(funcao, ms = 300) {
  let relogio;
  return () => { clearTimeout(relogio); relogio = setTimeout(funcao, ms); };
}

// Lista dos últimos meses (do mais recente para o mais antigo), para os seletores de mês.
function ultimosMeses(quantidade = 24) {
  const hoje = new Date();
  const meses = [];
  for (let i = 0; i < quantidade; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return meses;
}

// Monta "de=2026-10&ate=2026-10&busca=..." a partir de um objeto, pulando o que está vazio.
function parametros(objeto) {
  const p = new URLSearchParams();
  for (const [chave, valor] of Object.entries(objeto)) if (valor !== '' && valor !== undefined && valor !== null) p.set(chave, valor);
  return p.toString();
}

// Paginação: em vez de esticar a tela com centenas de linhas, mostra 10 por vez com "Anterior" e "Próxima".
// Uso:  const paginas = criarPaginacao('linhas', 'paginacao');
//       paginas.mostrar(listaDeLinhasEmHtml, '<tr>...mensagem de lista vazia...</tr>', 'lojas');
// Os totais do rodapé da tabela continuam somando TODAS as linhas, não só as da página.
function criarPaginacao(idCorpo, idNavegacao, porPagina = 10) {
  const corpo = document.getElementById(idCorpo);
  const navegacao = document.getElementById(idNavegacao);
  let linhas = [];
  let pagina = 1;
  let nomeDosItens = 'linhas';

  function desenhar() {
    const totalPaginas = Math.max(1, Math.ceil(linhas.length / porPagina));
    pagina = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (pagina - 1) * porPagina;
    corpo.innerHTML = linhas.slice(inicio, inicio + porPagina).join('');
    navegacao.hidden = linhas.length <= porPagina;
    navegacao.innerHTML = `
      <span>Mostrando ${inicio + 1} a ${Math.min(inicio + porPagina, linhas.length)} de ${linhas.length} ${esc(nomeDosItens)}</span>
      <span class="botoes-pagina">
        <button type="button" class="secundario pequeno" data-ir="${pagina - 1}"${pagina === 1 ? ' disabled' : ''}>← Anterior</button>
        <span>Página ${pagina} de ${totalPaginas}</span>
        <button type="button" class="secundario pequeno" data-ir="${pagina + 1}"${pagina === totalPaginas ? ' disabled' : ''}>Próxima →</button>
      </span>`;
  }

  navegacao.addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-ir]');
    if (!botao) return;
    pagina = Number(botao.dataset.ir);
    desenhar();
    corpo.closest('.painel').scrollIntoView({ block: 'nearest' }); // volta para o começo da tabela
  });

  return {
    // manterPagina = true: continua na página em que estava (ex.: depois de excluir uma linha).
    mostrar(novasLinhas, htmlVazio, nome, manterPagina = false) {
      linhas = novasLinhas;
      nomeDosItens = nome;
      if (!manterPagina) pagina = 1;
      if (!linhas.length) { corpo.innerHTML = htmlVazio; navegacao.hidden = true; return; }
      desenhar();
    },
  };
}

// Lê o "?id=15" do endereço das fichas (loja e promotor). Se não for um número válido, mostra o aviso
// e devolve null, para a tela não ficar em branco.
function idDoEndereco(nomeDoItem) {
  const texto = new URLSearchParams(location.search).get('id') || '';
  if (/^\d{1,9}$/.test(texto) && Number(texto) > 0) return Number(texto);
  mostrarAviso(document.getElementById('aviso'), `${nomeDoItem} não encontrada: o endereço desta página está incompleto ou errado. Volte para a lista e clique de novo.`);
  return null;
}

// ---------- Barra de filtros (Resumo, Faturamento, Promotores, Lojas por UF e Agências) ----------
// Período (acumulado ou um mês) + agência, tipo, UF, supervisor, município e mercado. Os filtros escolhidos
// aparecem como etiquetas com ✕ e ficam lembrados enquanto a aba estiver aberta (valem para todas as telas).
const CAMPOS_FILTRO = [
  { campo: 'agencia', rotulo: 'Agência' }, { campo: 'tipo', rotulo: 'Tipo' }, { campo: 'uf', rotulo: 'UF' },
  { campo: 'supervisor', rotulo: 'Supervisor' }, { campo: 'municipio', rotulo: 'Município' }, { campo: 'mercado', rotulo: 'Mercado' },
];
let filtros = {};
let aoMudarFiltros = () => {};
let nomesDosSupervisores = new Map(); // id -> nome, para a etiqueta do filtro

function lerFiltrosGuardados() {
  try { return JSON.parse(sessionStorage.getItem('filtros')) || {}; } catch { return {}; }
}
function guardarFiltros() {
  try { sessionStorage.setItem('filtros', JSON.stringify(filtros)); } catch { /* sem armazenamento */ }
}

function montarFiltros(opcoes, aoMudar) {
  aoMudarFiltros = aoMudar;
  filtros = lerFiltrosGuardados();
  // O filtro de supervisor é o id do supervisor. Um texto antigo guardado no navegador é descartado.
  const supervisores = (opcoes.supervisores || []).filter((sup) => sup && typeof sup === 'object');
  nomesDosSupervisores = new Map(supervisores.map((sup) => [String(sup.id), sup.nome]));
  if (filtros.supervisor && !nomesDosSupervisores.has(String(filtros.supervisor))) { delete filtros.supervisor; guardarFiltros(); }
  const opcoesDe = (lista, rotulo = (v) => v) => lista.map((v) => `<option value="${esc(v)}">${esc(rotulo(v))}</option>`).join('');
  document.getElementById('filtros-comuns').innerHTML = `
    <div class="campo"><label for="f-modo">Período</label>
      <select id="f-modo"><option value="acumulado">Acumulado</option><option value="mes">Um mês</option></select></div>
    <div class="campo"><label for="periodo-de" id="rotulo-de">De</label><select id="periodo-de"></select></div>
    <div class="campo" id="campo-ate"><label for="periodo-ate">Até</label><select id="periodo-ate"></select></div>
    <div class="campo"><label for="f-agencia">Agência</label><select id="f-agencia"><option value="">Todas</option>${opcoesDe(opcoes.agencias)}</select></div>
    <div class="campo"><label for="f-tipo">Tipo</label><select id="f-tipo"><option value="">Todos</option>${opcoesDe(Object.keys(TIPOS), (t) => TIPOS[t])}</select></div>
    <div class="campo estreito"><label for="f-uf">UF</label><select id="f-uf"><option value="">Todas</option>${opcoesDe(opcoes.ufs)}<option value="-">Sem UF</option></select></div>
    <div class="campo"><label for="f-supervisor">Supervisor</label><select id="f-supervisor"><option value="">Todos</option>${supervisores.map((sup) => `<option value="${sup.id}">${esc(sup.nome)}</option>`).join('')}</select></div>
    <div class="campo"><label for="f-municipio">Município</label><input id="f-municipio" list="lista-municipios" autocomplete="off" placeholder="Todos">
      <datalist id="lista-municipios">${opcoesDe(opcoes.municipios)}</datalist></div>
    <div class="campo"><label for="f-mercado">Mercado</label><input id="f-mercado" list="lista-mercados" autocomplete="off" placeholder="Loja ou rede">
      <datalist id="lista-mercados">${opcoesDe(opcoes.mercados)}</datalist></div>`;

  const modo = document.getElementById('f-modo');
  const de = document.getElementById('periodo-de');
  const ate = document.getElementById('periodo-ate');
  modo.value = filtros.modo === 'mes' ? 'mes' : 'acumulado';
  const aplicarModo = () => {
    const umMes = modo.value === 'mes';
    document.getElementById('campo-ate').hidden = umMes;
    document.getElementById('rotulo-de').textContent = umMes ? 'Mês' : 'De';
    if (umMes) { ate.value = de.value; lembrar('periodo-ate', ate.value); }
  };
  montarPeriodo(opcoes, () => { aplicarModo(); desenharEtiquetas(); aoMudarFiltros(); });
  aplicarModo();
  modo.addEventListener('change', () => {
    filtros.modo = modo.value;
    guardarFiltros();
    aplicarModo();
    desenharEtiquetas();
    aoMudarFiltros();
  });

  for (const { campo } of CAMPOS_FILTRO) {
    const elemento = document.getElementById(`f-${campo}`);
    elemento.value = filtros[campo] || '';
    const mudou = () => {
      const valor = elemento.value.trim();
      if ((filtros[campo] || '') === valor) return;
      if (valor) filtros[campo] = valor; else delete filtros[campo];
      guardarFiltros();
      desenharEtiquetas();
      aoMudarFiltros();
    };
    elemento.addEventListener('change', mudou);
    if (campo === 'mercado') elemento.addEventListener('input', comAtraso(mudou, 500));
  }
  document.getElementById('etiquetas').addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-tirar]');
    if (!botao) return;
    if (botao.dataset.tirar === '*') for (const { campo } of CAMPOS_FILTRO) definirFiltro(campo, '', false);
    else definirFiltro(botao.dataset.tirar, '', false);
    aoMudarFiltros();
  });
  desenharEtiquetas();
}

// Muda um filtro por código (ex.: os botões de UF da tela Lojas por UF).
function definirFiltro(campo, valor, recarregar = true) {
  if (valor) filtros[campo] = valor; else delete filtros[campo];
  const elemento = document.getElementById(`f-${campo}`);
  if (elemento) elemento.value = valor || '';
  guardarFiltros();
  desenharEtiquetas();
  if (recarregar) aoMudarFiltros();
}

function desenharEtiquetas() {
  const { de, ate } = periodoAtual();
  const umMes = filtros.modo === 'mes' || de === ate;
  const periodo = umMes ? rotuloMes(de) : `${rotuloMes(de)} a ${rotuloMes(ate)} (acumulado)`;
  const ativos = CAMPOS_FILTRO.filter(({ campo }) => filtros[campo]);
  const valorDe = (campo) => {
    if (campo === 'tipo') return TIPOS[filtros.tipo] || filtros.tipo;
    if (campo === 'uf' && filtros.uf === '-') return 'sem UF';
    if (campo === 'supervisor') return nomesDosSupervisores.get(String(filtros.supervisor)) || filtros.supervisor;
    return filtros[campo];
  };
  document.getElementById('etiquetas').innerHTML = `
    <span class="etiqueta-filtro fixa">Período: ${esc(periodo)}</span>
    ${ativos.map(({ campo, rotulo }) => `<span class="etiqueta-filtro">${esc(rotulo)}: ${esc(valorDe(campo))}
      <button type="button" data-tirar="${campo}" aria-label="Tirar o filtro ${esc(rotulo)}" title="Tirar o filtro">✕</button></span>`).join('')}
    ${ativos.length > 1 ? '<button type="button" class="secundario pequeno" data-tirar="*">Limpar filtros</button>' : ''}`;
}

// Período + filtros escolhidos, prontos para ir na chamada à API.
function filtrosAtuais() {
  const resultado = { ...periodoAtual() };
  for (const { campo } of CAMPOS_FILTRO) if (filtros[campo]) resultado[campo] = filtros[campo];
  return resultado;
}

// ---------- Avisos de qualidade dos dados ----------
// Caixas no topo da tela quando os números estão incompletos (vêm prontos do servidor).
function mostrarAvisos(avisos) {
  const caixa = document.getElementById('avisos');
  if (!caixa) return;
  caixa.innerHTML = (avisos || []).map((a) => `
    <div class="aviso-dados" role="note">
      <strong>${esc(a.titulo)}.</strong> ${esc(a.texto)}
      ${a.itens.length ? `<details><summary>Ver ${a.itens.length + a.mais === 1 ? 'qual' : 'quais'}</summary>
        <ul>${a.itens.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        ${a.mais ? `<p class="ajuda">E mais ${a.mais}. A lista completa sai na exportação para Excel ou nos filtros da tela.</p>` : ''}</details>` : ''}
    </div>`).join('');
}

// ---------- Ordenação de tabela por coluna ----------
// Cabeçalhos com data-ordem="campo" ficam clicáveis. "aoOrdenar(campo, direcao)" redesenha a tabela.
function ordenacaoNaTabela(thead, aoOrdenar, inicial = { campo: '', direcao: 1 }) {
  let atual = { ...inicial };
  const marcar = () => {
    for (const th of thead.querySelectorAll('th[data-ordem]')) {
      const ativo = th.dataset.ordem === atual.campo;
      th.setAttribute('aria-sort', ativo ? (atual.direcao > 0 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.seta').textContent = ativo ? (atual.direcao > 0 ? ' ▲' : ' ▼') : '';
    }
  };
  for (const th of thead.querySelectorAll('th[data-ordem]')) {
    th.innerHTML = `<button type="button" class="ordenar">${th.innerHTML}<span class="seta" aria-hidden="true"></span></button>`;
    th.querySelector('button').addEventListener('click', () => {
      atual = { campo: th.dataset.ordem, direcao: atual.campo === th.dataset.ordem ? -atual.direcao : (th.classList.contains('num') ? -1 : 1) };
      marcar();
      aoOrdenar(atual.campo, atual.direcao);
    });
  }
  marcar();
  return () => atual;
}

// Compara dois valores para ordenar: números como números, textos em ordem alfabética, vazios no fim.
function comparar(a, b, direcao) {
  const vazio = (v) => v === null || v === undefined || v === '';
  if (vazio(a) && vazio(b)) return 0;
  if (vazio(a)) return 1;
  if (vazio(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * direcao;
  return String(a).localeCompare(String(b), 'pt-BR') * direcao;
}
