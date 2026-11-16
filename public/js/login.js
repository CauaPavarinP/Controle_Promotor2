// Tela de login.
document.getElementById('form').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const aviso = document.getElementById('aviso');
  try {
    await api('/api/login', { method: 'POST', json: { login: document.getElementById('login').value, senha: document.getElementById('senha').value } });
    location.href = '/resumo';
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
});
