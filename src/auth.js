// Login, sessão e usuários do sistema.
// Perfis: "suporte" (faz tudo e administra usuários) e "usuario" (faz tudo, menos administrar usuários).
const bcrypt = require('bcryptjs');
const { consulta } = require('./db');

const SENHA_MINIMA = 8;
const PERFIS = ['suporte', 'usuario'];

class ErroDeValidacao extends Error {}

function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < SENHA_MINIMA) {
    throw new ErroDeValidacao(`A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`);
  }
}

function limparLogin(login) {
  const limpo = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(limpo)) {
    throw new ErroDeValidacao('O login deve ter de 3 a 40 caracteres: letras, números, ponto, traço ou sublinhado.');
  }
  return limpo;
}

// ----- Proteção contra tentativa de adivinhar senha: 5 erros seguidos bloqueiam o login por 15 minutos -----
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;
const tentativas = new Map();
// Hash de mentira, usado quando o login não existe (ver "entrar").
const HASH_FALSO = bcrypt.hashSync('senha-que-ninguem-usa', 10);

function estaBloqueado(chave) {
  const t = tentativas.get(chave);
  if (!t) return false;
  if (Date.now() - t.inicio > BLOQUEIO_MS) { tentativas.delete(chave); return false; }
  return t.erros >= MAX_TENTATIVAS;
}

function registrarErro(chave) {
  const t = tentativas.get(chave);
  if (!t || Date.now() - t.inicio > BLOQUEIO_MS) tentativas.set(chave, { erros: 1, inicio: Date.now() });
  else t.erros++;
}

async function entrar(login, senha, ip) {
  const chave = `${String(login || '').trim().toLowerCase()}|${ip}`;
  if (estaBloqueado(chave)) throw new ErroDeValidacao('Muitas tentativas. Aguarde 15 minutos e tente de novo.');
  const [usuario] = await consulta('SELECT * FROM usuarios WHERE login = $1', [String(login || '').trim().toLowerCase()]);
  // Compara a senha mesmo quando o usuário não existe, para a resposta demorar o mesmo tempo nos dois casos.
  const hash = usuario ? usuario.senha_hash : HASH_FALSO;
  const senhaCerta = await bcrypt.compare(String(senha || ''), hash);
  if (!usuario || !senhaCerta || !usuario.ativo) {
    registrarErro(chave);
    throw new ErroDeValidacao('Login ou senha incorretos.');
  }
  tentativas.delete(chave);
  return { id: usuario.id, login: usuario.login, nome: usuario.nome, perfil: usuario.perfil };
}

// ----- Filtros das rotas -----

// Confere a cada chamada se o usuário ainda existe e está ativo (se foi desativado, perde o acesso na hora).
async function exigirLogin(req, res, next) {
  const id = req.session && req.session.usuarioId;
  const [usuario] = id ? await consulta('SELECT id, login, nome, perfil FROM usuarios WHERE id = $1 AND ativo', [id]) : [];
  if (!usuario) {
    req.session = null;
    return res.status(401).json({ erro: 'Faça login para continuar.' });
  }
  req.usuario = usuario;
  next();
}

function exigirSuporte(req, res, next) {
  if (req.usuario.perfil !== 'suporte') return res.status(403).json({ erro: 'Só o suporte pode fazer isso.' });
  next();
}

// ----- Usuários -----

async function listarUsuarios() {
  return consulta('SELECT id, login, nome, perfil, ativo, criado_em FROM usuarios ORDER BY nome');
}

async function criarUsuario({ login, nome, senha, perfil }) {
  login = limparLogin(login);
  nome = String(nome || '').trim();
  if (!nome) throw new ErroDeValidacao('Informe o nome.');
  if (!PERFIS.includes(perfil)) throw new ErroDeValidacao('Perfil inválido.');
  validarSenha(senha);
  const [existe] = await consulta('SELECT id FROM usuarios WHERE login = $1', [login]);
  if (existe) throw new ErroDeValidacao('Já existe um usuário com esse login.');
  const hash = await bcrypt.hash(senha, 10);
  const [criado] = await consulta(
    'INSERT INTO usuarios (login, nome, senha_hash, perfil) VALUES ($1, $2, $3, $4) RETURNING id, login, nome, perfil, ativo',
    [login, nome, hash, perfil],
  );
  return criado;
}

// O sistema nunca pode ficar sem ninguém do suporte ativo, senão ninguém mais administra os usuários.
async function garantirOutroSuporte(id) {
  const [{ total }] = await consulta("SELECT count(*)::int AS total FROM usuarios WHERE perfil = 'suporte' AND ativo AND id <> $1", [id]);
  if (total === 0) throw new ErroDeValidacao('Este é o único usuário de suporte ativo. Crie outro antes.');
}

async function atualizarUsuario(id, { nome, perfil, ativo, senha }, quemPediu) {
  const [atual] = await consulta('SELECT * FROM usuarios WHERE id = $1', [id]);
  if (!atual) throw new ErroDeValidacao('Usuário não encontrado.');
  const novo = {
    nome: nome === undefined ? atual.nome : String(nome).trim(),
    perfil: perfil === undefined ? atual.perfil : perfil,
    ativo: ativo === undefined ? atual.ativo : Boolean(ativo),
  };
  if (!novo.nome) throw new ErroDeValidacao('Informe o nome.');
  if (!PERFIS.includes(novo.perfil)) throw new ErroDeValidacao('Perfil inválido.');
  const perdeSuporte = atual.perfil === 'suporte' && atual.ativo && (novo.perfil !== 'suporte' || !novo.ativo);
  if (perdeSuporte) {
    if (id === quemPediu.id) throw new ErroDeValidacao('Você não pode tirar o seu próprio acesso de suporte.');
    await garantirOutroSuporte(id);
  }
  await consulta('UPDATE usuarios SET nome = $1, perfil = $2, ativo = $3 WHERE id = $4', [novo.nome, novo.perfil, novo.ativo, id]);
  if (senha !== undefined && senha !== '') {
    validarSenha(senha);
    await consulta('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [await bcrypt.hash(senha, 10), id]);
  }
}

async function excluirUsuario(id, quemPediu) {
  if (id === quemPediu.id) throw new ErroDeValidacao('Você não pode excluir o seu próprio usuário.');
  const [atual] = await consulta('SELECT * FROM usuarios WHERE id = $1', [id]);
  if (!atual) throw new ErroDeValidacao('Usuário não encontrado.');
  if (atual.perfil === 'suporte' && atual.ativo) await garantirOutroSuporte(id);
  await consulta('DELETE FROM usuarios WHERE id = $1', [id]);
}

async function trocarPropriaSenha(id, senhaAtual, senhaNova) {
  const [usuario] = await consulta('SELECT senha_hash FROM usuarios WHERE id = $1', [id]);
  if (!usuario || !(await bcrypt.compare(String(senhaAtual || ''), usuario.senha_hash))) {
    throw new ErroDeValidacao('A senha atual está incorreta.');
  }
  validarSenha(senhaNova);
  await consulta('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [await bcrypt.hash(senhaNova, 10), id]);
}

// Cria o primeiro usuário (suporte) a partir das variáveis ADMIN_*, só quando o banco ainda não tem ninguém.
async function criarPrimeiroUsuario() {
  const [{ total }] = await consulta('SELECT count(*)::int AS total FROM usuarios');
  if (total > 0) return;
  const { ADMIN_LOGIN, ADMIN_NOME, ADMIN_SENHA } = process.env;
  if (!ADMIN_LOGIN || !ADMIN_SENHA) {
    console.warn('Aviso: não há nenhum usuário. Defina ADMIN_LOGIN e ADMIN_SENHA e reinicie para criar o primeiro.');
    return;
  }
  await criarUsuario({ login: ADMIN_LOGIN, nome: ADMIN_NOME || ADMIN_LOGIN, senha: ADMIN_SENHA, perfil: 'suporte' });
  console.log(`Primeiro usuário criado: ${ADMIN_LOGIN} (suporte).`);
}

module.exports = {
  entrar, exigirLogin, exigirSuporte, listarUsuarios, criarUsuario, atualizarUsuario, excluirUsuario,
  trocarPropriaSenha, criarPrimeiroUsuario, ErroDeValidacao,
};
