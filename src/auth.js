// Login, sessão e usuários do sistema.
// Perfis: "suporte" (faz tudo e administra usuários) e "usuario" (faz tudo, menos administrar usuários).
const bcrypt = require('bcryptjs');
const { consulta } = require('./db');

const SENHA_MINIMA = 8;
const PERFIS = ['suporte', 'usuario'];

class ErroDeValidacao extends Error {}

// Erro que precisa de um código de resposta específico (401 = não autorizado, 429 = tentativas demais).
class ErroDeAcesso extends ErroDeValidacao {
  constructor(mensagem, status) {
    super(mensagem);
    this.status = status;
  }
}

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

// ----- Proteção contra tentativa de adivinhar senha -----
// Contamos os erros de duas formas, por 15 minutos:
//  - por login + IP: 5 erros bloqueiam aquele login para aquele endereço (quem chuta a senha de UMA pessoa);
//  - só por IP: 20 erros bloqueiam o endereço inteiro (quem testa a mesma senha em VÁRIOS logins).
// Como o primeiro bloqueio vale só para o IP de quem errou, alguém de fora não consegue travar o login de
// outra pessoa. Dentro da empresa todos saem pelo mesmo IP, então lá um colega ainda conseguiria; o bloqueio
// dura só 15 minutos.
const MAX_POR_LOGIN = 5;
const MAX_POR_IP = 20;
const BLOQUEIO_MS = 15 * 60 * 1000;
const tentativas = new Map();
// Hash de mentira, usado quando o login não existe (ver "entrar").
const HASH_FALSO = bcrypt.hashSync('senha-que-ninguem-usa', 10);

function errosDe(chave) {
  const t = tentativas.get(chave);
  if (!t) return 0;
  if (Date.now() - t.inicio > BLOQUEIO_MS) { tentativas.delete(chave); return 0; }
  return t.erros;
}

function registrarErro(chave) {
  if (errosDe(chave) === 0) tentativas.set(chave, { erros: 1, inicio: Date.now() });
  else tentativas.get(chave).erros++;
  // Não deixa a lista crescer sem fim: de vez em quando joga fora os registros vencidos.
  if (tentativas.size > 5000) for (const outra of [...tentativas.keys()]) errosDe(outra);
}

async function entrar(login, senha, ip) {
  const loginLimpo = String(login || '').trim().toLowerCase().slice(0, 60);
  const chaveIp = `ip|${ip}`;
  const chaveLogin = `${loginLimpo}|${ip}`;
  if (errosDe(chaveIp) >= MAX_POR_IP || errosDe(chaveLogin) >= MAX_POR_LOGIN) {
    throw new ErroDeAcesso('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);
  }
  const [usuario] = await consulta('SELECT * FROM usuarios WHERE login = $1', [loginLimpo]);
  // Compara a senha mesmo quando o usuário não existe, para a resposta demorar o mesmo tempo nos dois casos.
  const hash = usuario ? usuario.senha_hash : HASH_FALSO;
  const senhaCerta = await bcrypt.compare(String(senha || ''), hash);
  if (!usuario || !senhaCerta || !usuario.ativo) {
    registrarErro(chaveIp);
    registrarErro(chaveLogin);
    throw new ErroDeAcesso('Login ou senha incorretos.', 401);
  }
  tentativas.delete(chaveLogin);
  return { id: usuario.id, login: usuario.login, nome: usuario.nome, perfil: usuario.perfil, sessaoVersao: usuario.sessao_versao };
}

// ----- Filtros das rotas -----

// Devolve o usuário logado (ou null). Confere no banco a cada chamada:
//  - se o usuário foi desativado, perde o acesso na hora;
//  - se a versão da sessão do cookie não é a atual (a pessoa saiu ou trocou a senha depois), o cookie não vale mais.
//    Cookie sem versão (feito antes desta mudança) também não vale: a pessoa só precisa entrar de novo.
async function usuarioDaSessao(req) {
  const id = req.session && req.session.usuarioId;
  const versao = req.session && req.session.versao;
  if (!Number.isInteger(id) || !Number.isInteger(versao)) return null;
  const [usuario] = await consulta('SELECT id, login, nome, perfil FROM usuarios WHERE id = $1 AND ativo AND sessao_versao = $2', [id, versao]);
  return usuario || null;
}

// Invalida TODAS as sessões abertas do usuário (em qualquer computador). Devolve a versão nova.
async function encerrarSessoes(id) {
  const [r] = await consulta('UPDATE usuarios SET sessao_versao = sessao_versao + 1 WHERE id = $1 RETURNING sessao_versao', [id]);
  return r ? r.sessao_versao : null;
}

// Para as rotas da API: sem login, responde 401.
async function exigirLogin(req, res, next) {
  const usuario = await usuarioDaSessao(req);
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

async function lerUsuario(id) {
  const [u] = await consulta('SELECT id, login, nome, perfil, ativo FROM usuarios WHERE id = $1', [id]);
  return u || null;
}

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
  const trocaSenha = senha !== undefined && senha !== '';
  if (trocaSenha) validarSenha(senha); // antes de gravar qualquer coisa: senha curta não muda nada
  const perdeSuporte = atual.perfil === 'suporte' && atual.ativo && (novo.perfil !== 'suporte' || !novo.ativo);
  if (perdeSuporte) {
    if (id === quemPediu.id) throw new ErroDeValidacao('Você não pode tirar o seu próprio acesso de suporte.');
    await garantirOutroSuporte(id);
  }
  // Desativar também aumenta a versão da sessão. Sem isso, "desativar" só barrava o acesso ENQUANTO o usuário
  // estivesse inativo: se o suporte o reativasse em menos de 12 h, um cookie de antes da desativação (até um
  // copiado ou roubado) voltava a valer. Com a versão nova, quem foi desativado precisa entrar de novo.
  const desativou = atual.ativo && !novo.ativo;
  await consulta(`UPDATE usuarios SET nome = $1, perfil = $2, ativo = $3, sessao_versao = sessao_versao + CASE WHEN $5 THEN 1 ELSE 0 END
    WHERE id = $4`, [novo.nome, novo.perfil, novo.ativo, id, desativou]);
  if (trocaSenha) {
    // Senha nova definida pelo suporte: derruba as sessões abertas daquela pessoa.
    await consulta('UPDATE usuarios SET senha_hash = $1, sessao_versao = sessao_versao + 1 WHERE id = $2', [await bcrypt.hash(senha, 10), id]);
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
  // Derruba as outras sessões (outros computadores, cookie copiado). Devolve a versão nova para a rota manter
  // logada a sessão de quem acabou de trocar.
  const [r] = await consulta('UPDATE usuarios SET senha_hash = $1, sessao_versao = sessao_versao + 1 WHERE id = $2 RETURNING sessao_versao',
    [await bcrypt.hash(senhaNova, 10), id]);
  return r.sessao_versao;
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
  entrar, usuarioDaSessao, encerrarSessoes, lerUsuario, exigirLogin, exigirSuporte, listarUsuarios, criarUsuario, atualizarUsuario, excluirUsuario,
  trocarPropriaSenha, criarPrimeiroUsuario, ErroDeValidacao,
};
