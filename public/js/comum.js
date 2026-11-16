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
const reais = (valor) => formatoReais.format(valor || 0);
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
  dentro: 'Dentro da meta', fora: 'Fora da meta', sem_faturamento: 'Sem faturamento', sem_lojas: 'Sem lojas', sem_dados: 'Sem dados', sem_promotor: 'Sem promotor',
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
    ['/resumo', 'Resumo'], ['/faturamento', 'Faturamento'], ['/promotores', 'Promotores'], ['/importar', 'Importar'],
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
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  // Lista de meses: do mais antigo com dados (ou 12 meses atrás) até o mais recente (ou o mês atual).
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - 12, 1);
  let primeiro = `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, '0')}`;
  let ultimo = mesAtual;
  if (opcoes.meses.length) {
    if (opcoes.meses[0] < primeiro) primeiro = opcoes.meses[0];
    if (opcoes.meses.at(-1) > ultimo) ultimo = opcoes.meses.at(-1);
  }
  const meses = [];
  let [ano, mes] = primeiro.split('-').map(Number);
  while (`${ano}-${String(mes).padStart(2, '0')}` <= ultimo) {
    meses.push(`${ano}-${String(mes).padStart(2, '0')}`);
    mes++;
    if (mes > 12) { mes = 1; ano++; }
  }
  const html = meses.reverse().map((m) => `<option value="${m}">${rotuloMes(m)}</option>`).join('');
  de.innerHTML = html;
  ate.innerHTML = html;
  // Abre no último período usado; se não houver, no mês mais recente que tem faturamento E atendimentos
  // (é o único em que dá para comparar custo com faturamento); se nenhum tiver os dois, no mais recente com dados.
  const completos = opcoes.mesesFaturamento.filter((m) => opcoes.mesesAtendimentos.includes(m));
  const padrao = completos.at(-1) || opcoes.meses.at(-1) || mesAtual;
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

// Explica quando falta um dos dois tipos de dado no período (faturamento ou atendimentos).
// Sem isso a tela mostraria só zeros, parecendo quebrada. Devolve '' quando o período tem os dois.
function faltaNoPeriodo(opcoes) {
  const { de, ate } = periodoAtual();
  const noPeriodo = (meses) => meses.some((m) => m >= de && m <= ate);
  const periodo = de === ate ? rotuloMes(de) : `${rotuloMes(de)} a ${rotuloMes(ate)}`;
  const onde = (meses) => (meses.length ? `Há dados em: ${meses.map(rotuloMes).join(', ')}.` : 'Ainda não foi importado nenhum.');
  const faltas = [];
  if (!noPeriodo(opcoes.mesesAtendimentos)) faltas.push(`Não há atendimentos de promotores em ${periodo}. ${onde(opcoes.mesesAtendimentos)}`);
  if (!noPeriodo(opcoes.mesesFaturamento)) faltas.push(`Não há faturamento em ${periodo}. ${onde(opcoes.mesesFaturamento)}`);
  // Tem os dois no período, mas em meses diferentes: a comparação é feita mês a mês, então também não fecha.
  const juntos = opcoes.mesesAtendimentos.some((m) => m >= de && m <= ate && opcoes.mesesFaturamento.includes(m));
  if (!faltas.length && !juntos) {
    faltas.push(`Em ${periodo}, o faturamento e os atendimentos estão em meses diferentes (faturamento: ${opcoes.mesesFaturamento.map(rotuloMes).join(', ')}; atendimentos: ${opcoes.mesesAtendimentos.map(rotuloMes).join(', ')}). O custo de um mês só é comparado com o faturamento do mesmo mês.`);
  }
  if (!faltas.length) return '';
  return `${faltas.join(' ')} Para comparar custo com faturamento, escolha um período que tenha os dois ou importe o que falta.`;
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
