// Supervisores (cadastro separado dos promotores) e promotores que a importação não conseguiu identificar.
const { consulta, transacao } = require('./db');
const { normalizar, primeiroNome, ehSupervisor } = require('./planilha');
const { gravarSupervisor } = require('./ligacaoSupervisor');
const { ErroDeValidacao } = require('./auth');

const texto = (v, tamanho) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, tamanho);

// ---------- Supervisores ----------

async function listarCadastro() {
  return consulta('SELECT id, nome, codigo, cargo, empresa FROM supervisores ORDER BY nome');
}

async function criarSupervisor(dados) {
  const nome = texto(dados.nome, 120);
  if (!nome) throw new ErroDeValidacao('Informe o nome do supervisor.');
  const [existe] = await consulta('SELECT id FROM supervisores WHERE chave = $1', [normalizar(nome)]);
  if (existe) throw new ErroDeValidacao('Já existe um supervisor com esse nome.');
  await transacao((rodar) => gravarSupervisor(rodar, {
    nome, codigo: texto(dados.codigo, 30), cargo: texto(dados.cargo, 60) || 'Supervisor', empresa: texto(dados.empresa, 120),
  }));
}

async function excluirSupervisor(id) {
  const apagados = await consulta('DELETE FROM supervisores WHERE id = $1 RETURNING id', [id]);
  return apagados.length > 0;
}

// Editar nome e código. O nome muda a "chave" (nome sem acento), que não pode repetir.
async function editarSupervisor(id, dados) {
  const nome = texto(dados.nome, 120);
  if (!nome) throw new ErroDeValidacao('Informe o nome do supervisor.');
  const [outro] = await consulta('SELECT id FROM supervisores WHERE chave = $1 AND id <> $2', [normalizar(nome), id]);
  if (outro) throw new ErroDeValidacao('Já existe outro supervisor com esse nome. Use "Juntar" para unir os dois.');
  const r = await consulta('UPDATE supervisores SET nome = $1, chave = $2, codigo = $3 WHERE id = $4 RETURNING id', [nome, normalizar(nome), texto(dados.codigo, 30), id]);
  return r.length > 0;
}

// Juntar: o supervisor "origem" é a mesma pessoa que o "destino" (ex.: "Leo" e "Leonardo Silva").
// Os vínculos da origem passam para o destino e a origem é apagada. Numa transação só.
async function juntarSupervisores(origemId, destinoId) {
  if (!Number.isInteger(destinoId) || destinoId < 1 || destinoId === origemId) throw new ErroDeValidacao('Escolha com qual supervisor juntar.');
  return transacao(async (rodar) => {
    const [origem] = await rodar('SELECT * FROM supervisores WHERE id = $1 FOR UPDATE', [origemId]);
    const [destino] = await rodar('SELECT * FROM supervisores WHERE id = $1 FOR UPDATE', [destinoId]);
    if (!origem || !destino) throw new ErroDeValidacao('Supervisor não encontrado.');
    const movidos = await rodar(`INSERT INTO visita_supervisor (visita_id, supervisor_id)
      SELECT visita_id, $2 FROM visita_supervisor WHERE supervisor_id = $1 ON CONFLICT DO NOTHING RETURNING 1`, [origemId, destinoId]);
    await rodar(`UPDATE supervisores SET codigo = CASE WHEN codigo = '' THEN $2 ELSE codigo END,
      empresa = CASE WHEN empresa = '' THEN $3 ELSE empresa END, usuario_id = coalesce(usuario_id, $4) WHERE id = $1`,
    [destinoId, origem.codigo, origem.empresa, origem.usuario_id]);
    await rodar('DELETE FROM supervisores WHERE id = $1', [origemId]); // os vínculos dela saem junto
    return { atendimentos: movidos.length, supervisor: destino.nome };
  });
}

// ---------- Promotores não identificados ----------

const PROMOTORES_DO_CADASTRO = "SELECT id, nome, agencia, empresa, codigo, tipo, cargo, cadastrado FROM promotores WHERE pendente = '' ORDER BY nome";

// Lista os pendentes, com sugestões: quem tem o mesmo primeiro nome (os da mesma agência/empresa primeiro).
async function naoIdentificados() {
  const [pendentes, cadastro] = await Promise.all([
    consulta(`SELECT p.id, p.nome, p.agencia, p.tipo, p.codigo, p.pendente,
        (SELECT count(DISTINCT v.loja_id)::int FROM visitas v WHERE v.promotor_id = p.id) AS lojas,
        (SELECT string_agg(DISTINCT v.mes, ', ' ORDER BY v.mes) FROM visitas v WHERE v.promotor_id = p.id) AS meses
      FROM promotores p WHERE p.pendente <> '' ORDER BY p.agencia, p.nome`),
    consulta(PROMOTORES_DO_CADASTRO).then((lista) => lista.filter((c) => !ehSupervisor(c.cargo))), // supervisor não é opção
  ]);
  return {
    pendentes: pendentes.map((p) => {
      const ag = normalizar(p.agencia);
      const mesmaEmpresa = (c) => ag && (normalizar(c.agencia) === ag || normalizar(c.empresa) === ag);
      const candidatos = cadastro.filter((c) => primeiroNome(c.nome) === primeiroNome(p.nome))
        .sort((x, y) => Number(mesmaEmpresa(y)) - Number(mesmaEmpresa(x)) || Number(y.cadastrado) - Number(x.cadastrado));
      return { ...p, meses: p.meses || '', candidatos: candidatos.map((c) => c.id) };
    }),
    cadastro,
  };
}

// Liga um promotor pendente a um promotor do cadastro: passa os atendimentos para ele, guarda a ligação para
// as próximas importações e apaga o pendente. Tudo numa transação.
async function ligarPromotor(pendenteId, destinoId) {
  if (!Number.isInteger(destinoId) || destinoId < 1 || destinoId === pendenteId) throw new ErroDeValidacao('Escolha o promotor do cadastro.');
  return transacao(async (rodar) => {
    const [pendente] = await rodar("SELECT * FROM promotores WHERE id = $1 AND pendente <> '' FOR UPDATE", [pendenteId]);
    if (!pendente) throw new ErroDeValidacao('Este promotor não está mais pendente.');
    const [destino] = await rodar("SELECT * FROM promotores WHERE id = $1 AND pendente = '' FOR UPDATE", [destinoId]);
    if (!destino || ehSupervisor(destino.cargo)) throw new ErroDeValidacao('Promotor do cadastro não encontrado.');

    // Se o promotor do cadastro já tem atendimento na mesma loja e mês, junta os dois (soma visitas e valor).
    await rodar(`UPDATE visitas d SET qtd_visitas = d.qtd_visitas + o.qtd_visitas,
        custo = CASE WHEN d.custo IS NULL AND o.custo IS NULL THEN NULL ELSE coalesce(d.custo, 0) + coalesce(o.custo, 0) END
      FROM visitas o WHERE o.promotor_id = $1 AND d.promotor_id = $2 AND d.loja_id = o.loja_id AND d.mes = o.mes`, [pendenteId, destinoId]);
    await rodar(`DELETE FROM visitas o USING visitas d
      WHERE o.promotor_id = $1 AND d.promotor_id = $2 AND d.loja_id = o.loja_id AND d.mes = o.mes`, [pendenteId, destinoId]);
    const movidos = await rodar('UPDATE visitas SET promotor_id = $2 WHERE promotor_id = $1 RETURNING 1', [pendenteId, destinoId]);
    if (!destino.agencia && pendente.agencia) await rodar('UPDATE promotores SET agencia = $1 WHERE id = $2', [pendente.agencia, destinoId]);
    await rodar(`INSERT INTO vinculos_promotor (nome, agencia, promotor_id) VALUES ($1, $2, $3)
      ON CONFLICT (nome, agencia) DO UPDATE SET promotor_id = EXCLUDED.promotor_id, criado_em = now()`,
    [normalizar(pendente.nome), normalizar(pendente.agencia), destinoId]);
    await rodar('DELETE FROM promotores WHERE id = $1', [pendenteId]);
    return { atendimentos: movidos.length, promotor: destino.nome };
  });
}

module.exports = {
  listarCadastro, criarSupervisor, editarSupervisor, excluirSupervisor, juntarSupervisores, naoIdentificados, ligarPromotor,
};
