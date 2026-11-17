// Tela Supervisores: cada supervisor e os promotores dele no período (pelos vínculos dos atendimentos).
// Supervisor não é promotor: não tem custo, loja ou visita, e não entra em nenhum total.
const el = (id) => document.getElementById(id);
let dados = null;
let editando = null; // supervisor sendo editado (null = novo)
let juntando = null; // supervisor que vai ser juntado a outro
let excluindo = null; // supervisor que vai ser excluído (janela de confirmação)

const abertos = new Set(); // supervisores com a lista aberta (continua aberta ao trocar o filtro)

// ---------- Regras só de tela (não mudam nada no banco) ----------
// Nome comparável: sem acento, minúsculo, sem pontuação e com um espaço só entre as palavras.
const comparavel = (texto) => String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const plural = (n, um, varios) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;
// Nomes que não identificam uma pessoa (ex.: a palavra "Supervisor" escrita na coluna da planilha).
const NOMES_GENERICOS = new Set(['supervisor', 'supervisora', 'supervisores', 'sup', 'nao definido', 'nao informado', 'sem supervisor', 'sem nome', 'outro', 'outros']);

// Pendências que contam no card: sem código e nome genérico.
function pendenciasDe(s) {
  const lista = [];
  if (!String(s.codigo || '').trim()) lista.push({ tipo: 'sem-codigo', texto: 'Sem código' });
  if (NOMES_GENERICOS.has(comparavel(s.nome)) || comparavel(s.nome).length < 2) lista.push({ tipo: 'generico', texto: 'Nome genérico' });
  return lista;
}

// "Verificar" (não conta como pendência): outro supervisor do cadastro com o nome completo igual, ou em que um
// nome é o começo do outro (ex.: "Leo" e "Leonardo Silva"). Não usa só o primeiro nome, para não marcar nomes
// comuns. Compara com o cadastro inteiro, não só com quem aparece no período.
let todosSupervisores = [];
function parecidosCom(s) {
  const meu = comparavel(s.nome);
  if (meu.length < 3 || NOMES_GENERICOS.has(meu)) return [];
  return todosSupervisores.filter((outro) => {
    const dele = comparavel(outro.nome);
    if (outro.id === s.id || dele.length < 3 || NOMES_GENERICOS.has(dele)) return false;
    return dele === meu || dele.startsWith(meu) || meu.startsWith(dele);
  }).map((outro) => outro.nome);
}

function marcadores(s) {
  const pend = pendenciasDe(s).map((p) => `<span class="marca marca-pendencia" title="${p.tipo === 'sem-codigo'
    ? 'Cadastro sem código. Use Editar para informar, se houver.'
    : 'Nome que não identifica uma pessoa (veio assim na planilha). Veja os promotores dele e use Juntar com o supervisor certo, ou Excluir.'}">⚠ ${p.texto}</span>`);
  const parecidos = parecidosCom(s);
  if (parecidos.length) {
    pend.push(`<span class="marca marca-verificar" title="Pode ser a mesma pessoa que ${esc(parecidos.join(', '))}. Se for, use Juntar.">Verificar: parecido com ${esc(parecidos.join(', '))}</span>`);
  }
  return pend.length ? `<span class="marcas">${pend.join('')}</span>` : '';
}

// Promotores diferentes que têm algum supervisor (o mesmo promotor pode estar em mais de um supervisor).
const idsComSupervisor = (supervisores) => new Set(supervisores.flatMap((s) => s.promotores.map((p) => p.id)));

function desenharCards() {
  const lista = dados.supervisores;
  const comPromotor = lista.filter((s) => s.promotores.length).length;
  const pendentes = lista.filter((s) => pendenciasDe(s).length).length;
  el('cards-sup').innerHTML = `
    <div class="card"><div class="rotulo">Supervisores</div><div class="valor">${lista.length.toLocaleString('pt-BR')}</div>
      <div class="detalhe">${plural(comPromotor, 'com promotor', 'com promotores')} no período</div></div>
    <div class="card"><div class="rotulo">Promotores com supervisor</div><div class="valor">${idsComSupervisor(lista).size.toLocaleString('pt-BR')}</div>
      <div class="detalhe">Cada promotor contado uma vez</div></div>
    <div class="card"><div class="rotulo">Promotores sem supervisor</div><div class="valor">${dados.semSupervisor.length.toLocaleString('pt-BR')}</div>
      <div class="detalhe"><a href="#painel-sem-supervisor">Ver a lista</a></div></div>
    <div class="card ${pendentes ? 'atencao' : ''}"><div class="rotulo">Cadastros com pendência</div><div class="valor">${pendentes.toLocaleString('pt-BR')}</div>
      <div class="detalhe">Sem código ou nome genérico ·
        <button type="button" class="link" id="ver-pendencias">${filtroTela.soPendencias ? 'mostrar todos' : 'ver só esses'}</button></div></div>`;
}

// Chip com a quantidade e o que ela é ("37 promotores"). O de promotores e o de agências abrem a lista na linha
// de baixo; o de lojas é só informação.
function chipAbrir(s, quantidade, um, varios) {
  if (!quantidade) return `<span class="chip chip-zero">0 ${varios}</span>`;
  return `<button type="button" class="chip chip-abrir" data-abrir="${s.id}" aria-expanded="${abertos.has(s.id)}" aria-controls="detalhe-${s.id}"
    title="Abrir os promotores de ${esc(s.nome)}, por agência">${plural(quantidade, um, varios)}<span class="seta" aria-hidden="true"></span></button>`;
}
const chipTexto = (quantidade, um, varios) => (quantidade
  ? `<span class="chip chip-texto">${plural(quantidade, um, varios)}</span>` : `<span class="chip chip-zero">0 ${varios}</span>`);

// Linha que abre embaixo do supervisor: os promotores dele agrupados por agência (a com mais promotores primeiro),
// com o número de lojas de cada um nos atendimentos ligados a este supervisor. Sem rolagem interna.
function linhaDetalhe(s) {
  const porAgencia = new Map();
  for (const p of s.promotores) {
    if (!porAgencia.has(p.agencia)) porAgencia.set(p.agencia, []);
    porAgencia.get(p.agencia).push(p);
  }
  const grupos = [...porAgencia.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'pt-BR'));
  return `<tr class="detalhe-sup" id="detalhe-${s.id}" ${abertos.has(s.id) ? '' : 'hidden'}><td colspan="6">
    <div class="detalhe-sup-titulo">Promotores de ${esc(s.nome)} no período, por agência
      <span class="menor-inline">· ${plural(s.promotores.length, 'promotor', 'promotores')} em ${plural(grupos.length, 'agência', 'agências')}</span></div>
    <div class="grupos-agencia">${grupos.map(([agencia, promotores]) => `
      <section class="grupo-agencia">
        <h3>${esc(agencia)} <span class="menor-inline">${plural(promotores.length, 'promotor', 'promotores')}</span></h3>
        <ul>${promotores.map((p) => `<li><a href="/promotor?id=${p.id}">${esc(p.nome)}</a><span class="lojas">${plural(p.lojas, 'loja', 'lojas')}</span></li>`).join('')}</ul>
      </section>`).join('')}
    </div>
  </td></tr>`;
}
// Menu "⋯" da linha: Editar, Juntar e Excluir (Excluir pede confirmação numa janela).
const DICA_JUNTAR = 'Une dois cadastros que são a mesma pessoa (ex.: "Leo" e "Leonardo Silva"): os vínculos deste passam para o outro e este cadastro é apagado. Não dá para desfazer.';
function menuAcoes(s) {
  return `<div class="menu-acoes">
    <button type="button" class="botao-mais" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-${s.id}" title="Ações">⋯<span class="sr-only">Ações de ${esc(s.nome)}</span></button>
    <div class="menu-lista" role="menu" id="menu-${s.id}" hidden>
      <button type="button" role="menuitem" data-editar="${s.id}">Editar<small>Nome e código</small></button>
      <button type="button" role="menuitem" data-juntar="${s.id}" title="${esc(DICA_JUNTAR)}">Juntar com outro…<small>Mesma pessoa com dois cadastros</small></button>
      <button type="button" role="menuitem" class="item-perigo" data-excluir="${s.id}">Excluir…<small>Os atendimentos ficam, sem o vínculo</small></button>
    </div>
  </div>`;
}

function fecharMenus(exceto = null) {
  for (const botao of document.querySelectorAll('.botao-mais[aria-expanded="true"]')) {
    if (botao === exceto) continue;
    botao.setAttribute('aria-expanded', 'false');
    el(botao.getAttribute('aria-controls')).hidden = true;
  }
}

function alternarMenu(botao) {
  const abrir = botao.getAttribute('aria-expanded') !== 'true';
  fecharMenus(botao);
  botao.setAttribute('aria-expanded', String(abrir));
  const lista = el(botao.getAttribute('aria-controls'));
  lista.hidden = !abrir;
  if (abrir) lista.querySelector('[role="menuitem"]').focus();
}


// Filtros desta tela (só no navegador): busca por nome ou código, agência e "só pendências".
const filtroTela = { busca: '', agencia: '', soPendencias: false };
let ordem = () => ({ campo: 'nome', direcao: 1 }); // trocado pela ordenação do cabeçalho
const VALOR_PARA_ORDENAR = {
  nome: (s) => s.nome, codigo: (s) => s.codigo || '',
  promotores: (s) => s.promotores.length, agencias: (s) => s.agencias.length, lojas: (s) => s.lojas,
};

function passaNoFiltro(s) {
  const busca = comparavel(filtroTela.busca);
  if (busca && !comparavel(`${s.nome} ${s.codigo || ''}`).includes(busca)) return false;
  if (filtroTela.agencia && !s.agencias.includes(filtroTela.agencia)) return false;
  if (filtroTela.soPendencias && !pendenciasDe(s).length) return false;
  return true;
}

// Agências que aparecem na tela (dos supervisores e dos promotores sem supervisor).
function montarSeletorAgencia() {
  const agencias = [...new Set([...dados.supervisores.flatMap((s) => s.agencias), ...dados.semSupervisor.map((p) => p.agencia)])]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (filtroTela.agencia && !agencias.includes(filtroTela.agencia)) filtroTela.agencia = '';
  el('f-agencia-tela').innerHTML = `<option value="">Todas</option>${agencias.map((a) => `<option>${esc(a)}</option>`).join('')}`;
  el('f-agencia-tela').value = filtroTela.agencia;
}

function desenhar() {
  desenharCards();
  desenharTabela();
  desenharSemSupervisor();
}

async function carregar() {
  const aviso = el('aviso');
  try {
    dados = await api(`/api/supervisores?${parametros(filtrosAtuais())}`);
    todosSupervisores = (await carregarOpcoes()).supervisores || [];
    mostrarAviso(aviso, '');
    mostrarAvisos(dados.avisos);
    montarSeletorAgencia();
    desenhar();
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

function desenharTabela() {
  const { campo, direcao } = ordem();
  const valor = VALOR_PARA_ORDENAR[campo] || VALOR_PARA_ORDENAR.nome;
  const visiveis = dados.supervisores.filter(passaNoFiltro)
    .sort((a, b) => comparar(valor(a), valor(b), direcao) || a.nome.localeCompare(b.nome, 'pt-BR'));
  el('contagem-sup').textContent = visiveis.length === dados.supervisores.length
    ? plural(visiveis.length, 'supervisor', 'supervisores')
    : `Mostrando ${visiveis.length} de ${plural(dados.supervisores.length, 'supervisor', 'supervisores')}`;
  el('linhas').innerHTML = visiveis.map((s) => `
      <tr class="${abertos.has(s.id) ? 'aberto' : ''}" data-linha="${s.id}">
        <td><strong>${esc(s.nome)}</strong>${marcadores(s)}<span class="menor">${esc([s.cargo, s.empresa].filter(Boolean).join(' · '))}</span></td>
        <td>${s.codigo ? esc(s.codigo) : '<span class="menor-inline">—</span>'}</td>
        <td class="num">${chipAbrir(s, s.promotores.length, 'promotor', 'promotores')}</td>
        <td class="num">${chipAbrir(s, s.agencias.length, 'agência', 'agências')}</td>
        <td class="num">${chipTexto(s.lojas, 'loja', 'lojas')}</td>
        <td class="acoes-linha">${menuAcoes(s)}</td>
      </tr>${s.promotores.length ? linhaDetalhe(s) : ''}`).join('')
    || `<tr><td colspan="6" class="vazio">${dados.supervisores.length ? 'Nenhum supervisor com essa busca ou filtro.' : 'Nenhum supervisor com promotor nestes filtros.'}</td></tr>`;
}

// ---------- Promotores sem supervisor: tabela agrupada por agência, com busca ----------
const gruposFechados = new Set();
let buscaSem = '';

// Mesmo nome (sem acento) em agências diferentes, entre todos os promotores da tela. São cadastros diferentes:
// pode ser a mesma pessoa, então só avisa.
function agenciasPorNome() {
  const mapa = new Map();
  const todos = [...dados.semSupervisor, ...dados.supervisores.flatMap((s) => s.promotores)];
  for (const p of todos) {
    const chave = comparavel(p.nome);
    if (!mapa.has(chave)) mapa.set(chave, new Set());
    mapa.get(chave).add(p.agencia);
  }
  return mapa;
}

function desenharSemSupervisor() {
  el('painel-sem-supervisor').hidden = !dados.semSupervisor.length;
  const busca = comparavel(buscaSem);
  const lista = dados.semSupervisor
    .filter((p) => !filtroTela.agencia || p.agencia === filtroTela.agencia)
    .filter((p) => !busca || comparavel(`${p.nome} ${p.agencia}`).includes(busca));
  const repetidos = agenciasPorNome();
  const grupos = new Map();
  for (const p of lista) {
    if (!grupos.has(p.agencia)) grupos.set(p.agencia, []);
    grupos.get(p.agencia).push(p);
  }
  const ordenados = [...grupos.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  el('contagem-sem').textContent = lista.length === dados.semSupervisor.length
    ? `${plural(lista.length, 'promotor', 'promotores')} em ${plural(ordenados.length, 'agência', 'agências')}`
    : `Mostrando ${lista.length} de ${plural(dados.semSupervisor.length, 'promotor', 'promotores')}`;
  el('alternar-grupos').textContent = ordenados.every(([a]) => gruposFechados.has(a)) ? 'Abrir todos' : 'Recolher todos';
  el('sem-supervisor').innerHTML = ordenados.map(([agencia, promotores]) => {
    const aberto = busca || !gruposFechados.has(agencia); // com busca, mostra tudo o que achou
    return `<tr class="grupo-linha"><th colspan="3">
        <button type="button" class="abrir" data-grupo="${esc(agencia)}" aria-expanded="${Boolean(aberto)}"><span class="seta" aria-hidden="true">${aberto ? '▾' : '▸'}</span>${esc(agencia)}
          <span class="menor-inline">· ${plural(promotores.length, 'promotor', 'promotores')}</span></button></th></tr>
      ${aberto ? promotores.map((p) => {
    const outras = [...(repetidos.get(comparavel(p.nome)) || [])].filter((a) => a !== p.agencia);
    const aviso = outras.length ? `<span class="marca marca-verificar" title="O mesmo nome aparece em: ${esc(outras.join(', '))}. Podem ser cadastros diferentes da mesma pessoa.">Nome repetido em outra agência</span>` : '';
    return `<tr data-promotor="${p.id}"><td><a href="/promotor?id=${p.id}">${esc(p.nome)}</a> ${aviso}</td><td>${esc(TIPOS[p.tipo] || p.tipo || '—')}</td><td class="num">${p.lojas}</td></tr>`;
  }).join('') : ''}`;
  }).join('') || '<tr><td colspan="3" class="vazio">Nenhum promotor com essa busca ou agência.</td></tr>';
}

const supervisor = (id) => dados.supervisores.find((s) => s.id === Number(id));
const depoisDeMudar = () => { const eu = guardado('eu'); esquecerTudo(); if (eu) guardar('eu', eu); return carregar(); };

function abrirFormulario(s) {
  editando = s || null;
  el('janela-supervisor').querySelector('form').reset();
  el('titulo-supervisor').textContent = s ? 'Editar supervisor' : 'Novo supervisor';
  if (s) { el('s-nome').value = s.nome; el('s-codigo').value = s.codigo || ''; }
  mostrarAviso(el('aviso-supervisor'), '');
  el('janela-supervisor').showModal();
}

(async () => {
  await iniciarPagina();
  const opcoes = await carregarOpcoes();
  montarFiltros(opcoes, carregar);
  carregar();

  ordem = ordenacaoNaTabela(el('cabecalho-sup'), desenharTabela, { campo: 'nome', direcao: 1 });
  el('novo').addEventListener('click', () => abrirFormulario(null));
  // Filtros desta tela: redesenham sem ir ao servidor.
  el('f-busca-sup').addEventListener('input', comAtraso(() => { filtroTela.busca = el('f-busca-sup').value; desenharTabela(); }, 150));
  el('f-agencia-tela').addEventListener('change', () => { filtroTela.agencia = el('f-agencia-tela').value; desenhar(); });
  el('f-pendencias').addEventListener('change', () => { filtroTela.soPendencias = el('f-pendencias').checked; desenhar(); });
  el('cards-sup').addEventListener('click', (evento) => {
    if (!evento.target.closest('#ver-pendencias')) return;
    filtroTela.soPendencias = !filtroTela.soPendencias;
    el('f-pendencias').checked = filtroTela.soPendencias;
    desenhar();
  });
  el('s-cancelar').addEventListener('click', () => el('janela-supervisor').close());
  el('janela-supervisor').querySelector('form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const corpo = { nome: el('s-nome').value, codigo: el('s-codigo').value };
    try {
      if (editando) await api(`/api/supervisores/${editando.id}`, { method: 'PUT', json: corpo });
      else await api('/api/supervisores', { method: 'POST', json: corpo });
      el('janela-supervisor').close();
      depoisDeMudar();
    } catch (erro) {
      mostrarAviso(el('aviso-supervisor'), erro.message);
    }
  });

  el('juntar-cancelar').addEventListener('click', () => el('janela-juntar').close());
  el('janela-juntar').querySelector('form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      const r = await api(`/api/supervisores/${juntando.id}/juntar`, { method: 'POST', json: { destinoId: Number(el('juntar-destino').value) } });
      el('janela-juntar').close();
      mostrarAviso(el('aviso'), `Juntado: ${r.atendimentos} atendimento(s) passaram para ${r.supervisor}.`, 'ok');
      depoisDeMudar();
    } catch (erro) {
      mostrarAviso(el('aviso-juntar'), erro.message);
    }
  });

  el('linhas').addEventListener('click', async (evento) => {
    const abrir = evento.target.closest('button[data-abrir]');
    if (abrir) {
      const id = Number(abrir.dataset.abrir);
      const abrirAgora = !abertos.has(id);
      if (abrirAgora) abertos.add(id); else abertos.delete(id);
      el(`detalhe-${id}`).hidden = !abrirAgora;
      document.querySelector(`tr[data-linha="${id}"]`).classList.toggle('aberto', abrirAgora);
      for (const b of document.querySelectorAll(`button[data-abrir="${id}"]`)) b.setAttribute('aria-expanded', abrirAgora);
      return;
    }
    const mais = evento.target.closest('.botao-mais');
    if (mais) return alternarMenu(mais);
    fecharMenus();
    const editar = evento.target.closest('button[data-editar]');
    if (editar) return abrirFormulario(supervisor(editar.dataset.editar));
    const juntar = evento.target.closest('button[data-juntar]');
    if (juntar) {
      // A lista de destinos é o cadastro inteiro (mesmo quem não tem promotor no período).
      juntando = supervisor(juntar.dataset.juntar);
      const todos = (await carregarOpcoes()).supervisores.filter((s) => s.id !== juntando.id);
      el('juntar-origem').textContent = juntando.nome;
      el('juntar-origem-2').textContent = juntando.nome;
      el('juntar-destino').innerHTML = `<option value="">Escolha…</option>${todos.map((s) => `<option value="${s.id}">${esc(s.nome)}</option>`).join('')}`;
      mostrarAviso(el('aviso-juntar'), '');
      return el('janela-juntar').showModal();
    }
    const excluir = evento.target.closest('button[data-excluir]');
    if (!excluir) return;
    excluindo = supervisor(excluir.dataset.excluir);
    el('excluir-nome').textContent = excluindo.nome;
    el('excluir-detalhe').textContent = excluindo.promotores.length
      ? `Hoje ele está ligado a ${plural(excluindo.promotores.length, 'promotor', 'promotores')} neste período. Esses atendimentos continuam no sistema, só perdem o vínculo com este supervisor.`
      : 'Ele não tem promotores neste período.';
    mostrarAviso(el('aviso-excluir'), '');
    el('janela-excluir').showModal();
  });

  // Menu "⋯": fecha ao clicar fora ou com Esc (volta o foco para o botão).
  document.addEventListener('click', (evento) => { if (!evento.target.closest('.menu-acoes')) fecharMenus(); });
  document.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Escape') return;
    const aberto = document.querySelector('.botao-mais[aria-expanded="true"]');
    if (aberto) { fecharMenus(); aberto.focus(); }
  });

  el('f-busca-sem').addEventListener('input', comAtraso(() => { buscaSem = el('f-busca-sem').value; desenharSemSupervisor(); }, 150));
  el('sem-supervisor').addEventListener('click', (evento) => {
    const grupo = evento.target.closest('button[data-grupo]');
    if (!grupo || buscaSem) return;
    if (gruposFechados.has(grupo.dataset.grupo)) gruposFechados.delete(grupo.dataset.grupo); else gruposFechados.add(grupo.dataset.grupo);
    desenharSemSupervisor();
  });
  el('alternar-grupos').addEventListener('click', () => {
    const agencias = [...new Set(dados.semSupervisor.map((p) => p.agencia))];
    const fecharTodos = agencias.some((a) => !gruposFechados.has(a));
    for (const a of agencias) { if (fecharTodos) gruposFechados.add(a); else gruposFechados.delete(a); }
    desenharSemSupervisor();
  });

  el('excluir-cancelar').addEventListener('click', () => el('janela-excluir').close());
  el('janela-excluir').querySelector('form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      await api(`/api/supervisores/${excluindo.id}`, { method: 'DELETE' });
      el('janela-excluir').close();
      mostrarAviso(el('aviso'), `Supervisor "${excluindo.nome}" excluído.`, 'ok');
      depoisDeMudar();
    } catch (erro) {
      mostrarAviso(el('aviso-excluir'), erro.message);
    }
  });
})();
