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

// ---------- Histórico de alterações (auditoria) ----------
const ACOES = {
  'promotor.criar': 'Cadastrou promotor', 'promotor.editar': 'Editou promotor', 'promotor.excluir': 'Excluiu promotor',
  'atendimento.lancar': 'Lançou atendimento', 'atendimento.excluir': 'Excluiu atendimento', 'atendimentos.excluir_da_loja': 'Excluiu atendimentos da loja',
  'pendente.ligar': 'Ligou pendente', 'pendentes.excluir_sem_atendimento': 'Excluiu pendentes sem atendimento',
  'supervisor.criar': 'Cadastrou supervisor', 'supervisor.editar': 'Editou supervisor', 'supervisor.excluir': 'Excluiu supervisor', 'supervisor.juntar': 'Juntou supervisores',
  'importacao.gravar': 'Importou', 'importacao.desfazer': 'Desfez importação',
  'usuario.criar': 'Criou usuário', 'usuario.editar': 'Editou usuário', 'usuario.excluir': 'Excluiu usuário', 'conta.trocar_senha': 'Trocou a própria senha',
};
const dataHora = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const valorCurto = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Detalhes em texto curto: "campo: antes → depois" quando é uma edição; senão "chave: valor".
function textoDosDetalhes(d) {
  if (!d || typeof d !== 'object') return '';
  const partes = [];
  if (d.mudou && typeof d.mudou === 'object') {
    for (const [campo, m] of Object.entries(d.mudou)) partes.push(`${campo}: ${valorCurto(m.antes)} → ${valorCurto(m.depois)}`);
    if (!Object.keys(d.mudou).length) partes.push('nenhum campo mudou');
  }
  for (const [chave, valor] of Object.entries(d)) {
    const vazio = valor === null || valor === '' || valor === 0 || (typeof valor === 'object' && !Object.keys(valor).length);
    if (chave === 'mudou' || vazio) continue; // zeros e listas vazias não dizem nada
    partes.push(`${chave}: ${valorCurto(valor)}`);
  }
  return partes.join(' · ');
}

let buscaAtual = 0;
async function carregarAuditoria() {
  const minhaVez = ++buscaAtual;
  const busca = el('busca-auditoria').value.trim();
  try {
    const registros = await api(`/api/auditoria?${parametros({ busca })}`);
    if (minhaVez !== buscaAtual) return; // a pessoa já digitou outra coisa
    mostrarAviso(el('aviso-auditoria'), '');
    el('contagem-auditoria').textContent = `${registros.length} registro(s)`;
    el('linhas-auditoria').innerHTML = registros.length ? registros.map((r) => `
      <tr>
        <td>${esc(dataHora.format(new Date(r.criado_em)))}</td>
        <td>${esc(r.usuario || '—')}</td>
        <td>${esc(ACOES[r.acao] || r.acao)}</td>
        <td class="alvo-auditoria">${esc(r.alvo)}</td>
        <td class="detalhes-auditoria">${esc(textoDosDetalhes(r.detalhes))}</td>
      </tr>`).join('') : '<tr><td colspan="5">Nenhum registro.</td></tr>';
  } catch (erro) {
    mostrarAviso(el('aviso-auditoria'), erro.message);
  }
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
  carregarAuditoria();
  let espera;
  el('busca-auditoria').addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(carregarAuditoria, 300); });

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
      carregarAuditoria();
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
      carregarAuditoria();
    } catch (erro) {
      mostrarAviso(aviso, erro.message);
    }
  });
})();
