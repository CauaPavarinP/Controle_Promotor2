// Registro de quem fez o quê (auditoria). Cada alteração ou exclusão feita pela tela grava uma linha:
// quando, quem (id + nome e login daquele momento), a ação, em quem/no quê (alvo) e os detalhes.
//
// - Exclusões gravam o registro NA MESMA transação da exclusão: se o registro falhar, nada é apagado.
// - As outras ações gravam logo depois de dar certo. Se só o registro falhar, a ação continua feita e o
//   erro vai para o log do servidor (a pessoa não recebe erro por algo que já foi salvo).
// - Senhas NUNCA entram nos detalhes: só "senha redefinida: sim".
const { consulta } = require('./db');

const LIMITE_TEXTO = 300;

function quem(usuario) {
  return usuario ? `${usuario.nome} (${usuario.login})` : '';
}

// rodar: o comando SQL da transação em andamento (para gravar junto). Sem ele, grava sozinho.
async function registrar(usuario, acao, alvo = '', detalhes = {}, rodar = null) {
  const sql = 'INSERT INTO auditoria (usuario_id, usuario, acao, alvo, detalhes) VALUES ($1, $2, $3, $4, $5::jsonb)';
  const parametros = [usuario ? usuario.id : null, quem(usuario), acao, String(alvo ?? '').slice(0, LIMITE_TEXTO), JSON.stringify(detalhes ?? {})];
  return rodar ? rodar(sql, parametros) : consulta(sql, parametros);
}

// Versão para depois que a ação já deu certo: nunca derruba a resposta.
async function registrarDepois(usuario, acao, alvo, detalhes) {
  try {
    await registrar(usuario, acao, alvo, detalhes);
  } catch (erro) {
    console.error(`[auditoria] não foi possível registrar "${acao}" (${alvo}):`, erro.message);
  }
}

// Diferenças entre o antes e o depois de um registro (só os campos que mudaram).
function diferencas(antes, depois, ignorar = ['criado_em']) {
  const mudou = {};
  for (const campo of Object.keys(depois || {})) {
    if (ignorar.includes(campo)) continue;
    const a = antes ? antes[campo] : undefined;
    const d = depois[campo];
    if (!antes && (d === '' || d === 0 || d === null || d === false)) continue; // cadastro novo: só o que foi preenchido
    if (JSON.stringify(a) !== JSON.stringify(d)) mudou[campo] = { antes: a ?? null, depois: d ?? null };
  }
  return mudou;
}

// Últimos registros (mais novos primeiro), para a tela do suporte. Filtro opcional por texto.
async function listar({ busca = '', limite = 300 } = {}) {
  const n = Math.min(Math.max(Number(limite) || 300, 1), 1000);
  const termo = String(busca || '').trim().slice(0, 100);
  return consulta(`SELECT id, criado_em, usuario, acao, alvo, detalhes FROM auditoria
    WHERE $1 = '' OR usuario ILIKE '%' || $1 || '%' OR acao ILIKE '%' || $1 || '%' OR alvo ILIKE '%' || $1 || '%'
    ORDER BY id DESC LIMIT $2`, [termo, n]);
}

module.exports = { registrar, registrarDepois, diferencas, listar };
