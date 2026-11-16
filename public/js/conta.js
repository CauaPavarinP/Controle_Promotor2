// Tela Minha conta: o usuário troca a própria senha.
(async () => {
  const usuario = await iniciarPagina();
  document.getElementById('quem').textContent = `${usuario.nome} · login "${usuario.login}" · perfil ${usuario.perfil === 'suporte' ? 'Suporte' : 'Usuário'}`;
  const aviso = document.getElementById('aviso');
  document.getElementById('form').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const nova = document.getElementById('nova').value;
    try {
      if (nova !== document.getElementById('repetir').value) throw new Error('As duas senhas novas não são iguais.');
      await api('/api/conta/senha', { method: 'POST', json: { senhaAtual: document.getElementById('atual').value, senhaNova: nova } });
      evento.target.reset();
      mostrarAviso(aviso, 'Senha trocada.', 'ok');
    } catch (erro) {
      mostrarAviso(aviso, erro.message);
    }
  });
})();
