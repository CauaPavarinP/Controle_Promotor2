// Tela Usuários (só o suporte): criar, editar, redefinir senha, desativar e excluir.
const el = (id) => document.getElementById(id);
let usuarios = [];
let editando = null; // usuário que está sendo editado (null = novo)
let eu = null;

async function carregar() {
  usuarios = await api('/api/usuarios');
  el('linhas').innerHTML = usuarios.map((u) => `
    <tr>
      <td>${esc(u.nome)}${u.id === eu.id ? ' <span class="etiqueta">você</span>' : ''}</td>
      <td>${esc(u.login)}</td>
      <td>${u.perfil === 'suporte' ? 'Suporte' : 'Usuário'}</td>
      <td>${u.ativo ? '<span class="etiqueta dentro">Ativo</span>' : '<span class="etiqueta">Inativo</span>'}</td>
      <td class="num">
        <button type="button" class="secundario pequeno" data-acao="editar" data-id="${u.id}">Editar</button>
        ${u.id === eu.id ? '' : `
          <button type="button" class="secundario pequeno" data-acao="ativo" data-id="${u.id}">${u.ativo ? 'Desativar' : 'Reativar'}</button>
          <button type="button" class="perigo pequeno" data-acao="excluir" data-id="${u.id}">Excluir</button>`}
      </td>
    </tr>`).join('');
}

function abrir(usuario) {
  editando = usuario;
  el('form').reset();
  mostrarAviso(el('aviso-janela'), '');
  el('titulo-janela').textContent = usuario ? 'Editar usuário' : 'Novo usuário';
  el('u-login').disabled = Boolean(usuario);
  el('u-senha').required = !usuario;
  el('rotulo-senha').textContent = usuario ? 'Nova senha (deixe em branco para não mudar)' : 'Senha (mínimo 8 caracteres)';
  if (usuario) { el('u-nome').value = usuario.nome; el('u-login').value = usuario.login; el('u-perfil').value = usuario.perfil; }
  el('janela').showModal();
}

(async () => {
  eu = await iniciarPagina();
  const aviso = el('aviso');
  try { await carregar(); } catch (erro) { mostrarAviso(aviso, erro.message); return; }

  el('novo').addEventListener('click', () => abrir(null));
  el('cancelar').addEventListener('click', () => el('janela').close());

  el('form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const dados = { nome: el('u-nome').value, perfil: el('u-perfil').value, senha: el('u-senha').value };
    try {
      if (editando) await api(`/api/usuarios/${editando.id}`, { method: 'PUT', json: dados });
      else await api('/api/usuarios', { method: 'POST', json: { ...dados, login: el('u-login').value } });
      el('janela').close();
      mostrarAviso(aviso, 'Usuário salvo.', 'ok');
      await carregar();
    } catch (erro) {
      mostrarAviso(el('aviso-janela'), erro.message);
    }
  });

  el('linhas').addEventListener('click', async (evento) => {
    const botao = evento.target.closest('button[data-acao]');
    if (!botao) return;
    const usuario = usuarios.find((u) => u.id === Number(botao.dataset.id));
    try {
      if (botao.dataset.acao === 'editar') return abrir(usuario);
      if (botao.dataset.acao === 'ativo') {
        await api(`/api/usuarios/${usuario.id}`, { method: 'PUT', json: { ativo: !usuario.ativo } });
      } else if (botao.dataset.acao === 'excluir') {
        if (!confirm(`Excluir o usuário "${usuario.nome}"? Ele não conseguirá mais entrar.`)) return;
        await api(`/api/usuarios/${usuario.id}`, { method: 'DELETE' });
      }
      mostrarAviso(aviso, '');
      await carregar();
    } catch (erro) {
      mostrarAviso(aviso, erro.message);
    }
  });
})();
