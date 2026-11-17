// Tela Supervisores: cada supervisor e os promotores dele no período (pelos vínculos dos atendimentos).
// Supervisor não é promotor: não tem custo, loja ou visita, e não entra em nenhum total.
const el = (id) => document.getElementById(id);
let dados = null;
let editando = null; // supervisor sendo editado (null = novo)
let juntando = null; // supervisor que vai ser juntado a outro

function lista(itens, rotulo) {
  if (!itens.length) return '—';
  return `<details><summary>${itens.length}</summary><ul class="lista-curta">${itens.map((i) => `<li>${rotulo(i)}</li>`).join('')}</ul></details>`;
}
const promotorHtml = (p) => `<a href="/promotor?id=${p.id}">${esc(p.nome)}</a> <span class="menor-inline">${esc(p.agencia)} · ${p.lojas} loja(s)</span>`;

async function carregar() {
  const aviso = el('aviso');
  try {
    dados = await api(`/api/supervisores?${parametros(filtrosAtuais())}`);
    mostrarAviso(aviso, '');
    mostrarAvisos(dados.avisos);
    el('linhas').innerHTML = dados.supervisores.map((s) => `
      <tr>
        <td><strong>${esc(s.nome)}</strong><span class="menor">${esc([s.cargo, s.empresa].filter(Boolean).join(' · '))}</span></td>
        <td>${esc(s.codigo || '—')}</td>
        <td>${lista(s.promotores, promotorHtml)}</td>
        <td>${lista(s.agencias, esc)}</td>
        <td class="num">${s.lojas || '—'}</td>
        <td class="num">
          <button type="button" class="secundario pequeno" data-editar="${s.id}">Editar</button>
          <button type="button" class="secundario pequeno" data-juntar="${s.id}">Juntar</button>
          <button type="button" class="perigo pequeno" data-excluir="${s.id}">Excluir</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="vazio">Nenhum supervisor com promotor nestes filtros.</td></tr>';
    el('painel-sem-supervisor').hidden = !dados.semSupervisor.length;
    el('sem-supervisor').innerHTML = dados.semSupervisor.map((p) => `<li>${promotorHtml(p)}</li>`).join('');
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
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

  el('novo').addEventListener('click', () => abrirFormulario(null));
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
    const s = supervisor(excluir.dataset.excluir);
    if (!confirm(`Excluir o supervisor "${s.nome}"? Os atendimentos não mudam, só perdem o vínculo com ele. Se for a mesma pessoa que outro supervisor, use "Juntar".`)) return;
    try {
      await api(`/api/supervisores/${s.id}`, { method: 'DELETE' });
      depoisDeMudar();
    } catch (erro) {
      mostrarAviso(el('aviso'), erro.message);
    }
  });
})();
