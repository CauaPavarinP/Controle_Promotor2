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

// Monta o menu lateral e devolve o usuário logado. Toda tela (menos o login) chama isto primeiro.
async function iniciarPagina() {
  const usuario = await api('/api/eu');
  const paginas = [
    ['/resumo', 'Resumo'], ['/faturamento', 'Faturamento'], ['/promotores', 'Promotores'], ['/importar', 'Importar'],
  ];
  if (usuario.perfil === 'suporte') paginas.push(['/usuarios', 'Usuários']);
  const atual = location.pathname === '/promotor' ? '/promotores' : location.pathname;
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
    location.href = '/login';
  });
  return usuario;
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
