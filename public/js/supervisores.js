// Tela Supervisores: de quem cada supervisor é supervisor no período (promotores, agências e lojas).
// O suporte também vê os promotores com cargo de supervisor e pode movê-los para cá (com confirmação).
let usuario = null;
const el = (id) => document.getElementById(id);

// "3" que abre a lista com os nomes.
function lista(itens, rotulo) {
  if (!itens.length) return '—';
  return `<details><summary>${itens.length}</summary><ul class="lista-curta">${itens.map((i) => `<li>${rotulo(i)}</li>`).join('')}</ul></details>`;
}
const promotorHtml = (p) => `<a href="/promotor?id=${p.id}">${esc(p.nome)}</a> <span class="menor-inline">${esc(p.agencia)}</span>`;
const lojaHtml = (l) => `<a href="/loja?id=${l.id}">${esc(l.nome)}</a> <span class="menor-inline">${esc([l.cidade, l.uf].filter(Boolean).join(' · '))}</span>`;

async function carregar() {
  const aviso = el('aviso');
  try {
    const d = await api(`/api/supervisores?${parametros(filtrosAtuais())}`);
    mostrarAviso(aviso, '');
    mostrarAvisos(d.avisos);
    el('linhas').innerHTML = d.supervisores.map((s) => `
      <tr>
        <td><strong>${esc(s.nome)}</strong><span class="menor">${esc([s.cargo, s.empresa].filter(Boolean).join(' · '))}</span></td>
        <td>${esc(s.codigo || '—')}</td>
        <td>${lista(s.promotores, promotorHtml)}</td>
        <td>${lista(s.agencias, esc)}</td>
        <td>${lista(s.lojas, lojaHtml)}</td>
        <td class="num"><button type="button" class="perigo pequeno" data-excluir="${s.id}" data-nome="${esc(s.nome)}">Excluir</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum supervisor cadastrado com atendimento nestes filtros.</td></tr>';
    el('painel-sem-cadastro').hidden = !d.semCadastro.length;
    el('sem-cadastro').innerHTML = d.semCadastro.map((s) => `
      <tr>
        <td>${esc(s.nome)}</td>
        <td>${lista(s.promotores, promotorHtml)}</td>
        <td>${lista(s.agencias, esc)}</td>
        <td>${lista(s.lojas, lojaHtml)}</td>
        <td class="num"><button type="button" class="secundario pequeno" data-cadastrar="${esc(s.nome)}">Cadastrar</button></td>
      </tr>`).join('');
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

async function carregarCandidatos() {
  if (usuario.perfil !== 'suporte') return;
  const candidatos = await api('/api/supervisores/mover');
  el('painel-mover').hidden = !candidatos.length;
  el('candidatos').innerHTML = candidatos.map((c) => `
    <tr>
      <td><input type="checkbox" data-mover="${c.id}" ${c.atendimentos ? 'disabled' : 'checked'} aria-label="Mover ${esc(c.nome)}"></td>
      <td><a href="/promotor?id=${c.id}">${esc(c.nome)}</a></td><td>${esc(c.cargo)}</td><td>${esc(c.codigo || '—')}</td>
      <td>${esc(c.empresa || c.agencia || '—')}</td><td class="num">${reais(c.custo_fixo)}</td>
      <td class="num">${c.atendimentos || '—'}</td>
    </tr>`).join('');
}

function abrirNovo(nome = '') {
  el('janela-supervisor').querySelector('form').reset();
  el('s-nome').value = nome;
  mostrarAviso(el('aviso-supervisor'), '');
  el('janela-supervisor').showModal();
}

(async () => {
  usuario = await iniciarPagina();
  const opcoes = await carregarOpcoes();
  montarFiltros(opcoes, carregar);
  carregar();
  carregarCandidatos().catch((erro) => mostrarAviso(el('aviso'), erro.message));

  el('novo').addEventListener('click', () => abrirNovo());
  el('s-cancelar').addEventListener('click', () => el('janela-supervisor').close());
  el('janela-supervisor').querySelector('form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      await api('/api/supervisores', { method: 'POST', json: { nome: el('s-nome').value, codigo: el('s-codigo').value, empresa: el('s-empresa').value } });
      el('janela-supervisor').close();
      esquecerTudo(); // as listas lembradas (avisos, filtros) ficaram velhas
      carregar();
    } catch (erro) {
      mostrarAviso(el('aviso-supervisor'), erro.message);
    }
  });

  document.querySelector('main').addEventListener('click', async (evento) => {
    const cadastrar = evento.target.closest('button[data-cadastrar]');
    if (cadastrar) return abrirNovo(cadastrar.dataset.cadastrar);
    const excluir = evento.target.closest('button[data-excluir]');
    if (!excluir) return;
    if (!confirm(`Excluir o supervisor "${excluir.dataset.nome}"? Os atendimentos não mudam; o nome dele na planilha passa a aparecer como "sem cadastro".`)) return;
    try {
      await api(`/api/supervisores/${excluir.dataset.excluir}`, { method: 'DELETE' });
      carregar();
    } catch (erro) {
      mostrarAviso(el('aviso'), erro.message);
    }
  });

  el('mover').addEventListener('click', async () => {
    const marcados = [...document.querySelectorAll('#candidatos input[data-mover]:checked')];
    if (!marcados.length) return mostrarAviso(el('aviso'), 'Marque quem deve ser movido.');
    const nomes = marcados.map((m) => m.closest('tr').children[1].textContent);
    if (!confirm(`Mover ${nomes.length} promotor(es) para o cadastro de supervisores?\n\n${nomes.join('\n')}\n\nEles saem da lista de promotores e do custo. O salário cadastrado deles deixa de existir no sistema.`)) return;
    try {
      const r = await api('/api/supervisores/mover', { method: 'POST', json: { ids: marcados.map((m) => Number(m.dataset.mover)) } });
      const partes = [`${r.movidos.length} movido(s) para Supervisores.`];
      if (r.naoMovidos.length) partes.push(`Não movidos: ${r.naoMovidos.map((n) => `${n.nome || n.id} (${n.motivo})`).join('; ')}.`);
      mostrarAviso(el('aviso'), partes.join(' '), 'ok');
      esquecerTudo();
      await carregarCandidatos();
      carregar();
    } catch (erro) {
      mostrarAviso(el('aviso'), erro.message);
    }
  });
})();
