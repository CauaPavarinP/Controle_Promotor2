// Ligação de promotores "pendentes" (criados pela importação de atendimentos sem ter certeza de quem eram)
// ao promotor certo do cadastro. Usada pelo botão "Ligar" da tela, ao salvar um promotor pela tela e ao importar
// o cadastro de promotores. Todas as funções recebem "rodar" (o comando SQL da transação em andamento).
const { normalizar, codigoNormal } = require('./planilha');

// Nome comparável: sem acento, minúsculo, sem pontuação e com um espaço só entre as palavras.
const nomeNormal = (nome) => normalizar(nome);

// Passa os atendimentos do pendente para o destino, guarda a ligação para as próximas importações e apaga o
// pendente. Se o destino já tem atendimento na mesma loja e mês, junta os dois (soma visitas e valor).
async function ligarDentro(rodar, pendente, destino) {
  await rodar(`UPDATE visitas d SET qtd_visitas = d.qtd_visitas + o.qtd_visitas,
      custo = CASE WHEN d.custo IS NULL AND o.custo IS NULL THEN NULL ELSE coalesce(d.custo, 0) + coalesce(o.custo, 0) END
    FROM visitas o WHERE o.promotor_id = $1 AND d.promotor_id = $2 AND d.loja_id = o.loja_id AND d.mes = o.mes`, [pendente.id, destino.id]);
  await rodar(`DELETE FROM visitas o USING visitas d
    WHERE o.promotor_id = $1 AND d.promotor_id = $2 AND d.loja_id = o.loja_id AND d.mes = o.mes`, [pendente.id, destino.id]);
  const movidos = await rodar('UPDATE visitas SET promotor_id = $2 WHERE promotor_id = $1 RETURNING 1', [pendente.id, destino.id]);
  if (!destino.agencia && pendente.agencia) {
    await rodar('UPDATE promotores SET agencia = $1 WHERE id = $2', [pendente.agencia, destino.id]);
    destino.agencia = pendente.agencia;
  }
  await rodar(`INSERT INTO vinculos_promotor (nome, agencia, promotor_id) VALUES ($1, $2, $3)
    ON CONFLICT (nome, agencia) DO UPDATE SET promotor_id = EXCLUDED.promotor_id, criado_em = now()`,
  [normalizar(pendente.nome), normalizar(pendente.agencia), destino.id]);
  await rodar('DELETE FROM promotores WHERE id = $1', [pendente.id]);
  return movidos.length;
}

// O pendente é a mesma pessoa que o promotor do cadastro?
//  - mesmo código (sem zeros à esquerda: "06" = "6") E mesma agência (a agência do pendente igual à agência ou à
//    empresa do cadastro, porque o cadastro de CLT costuma ter só a empresa); ou
//  - mesmo nome normalizado (sem acento, minúsculo, sem espaços duplos), MENOS quando os dois têm código e os
//    códigos são diferentes: código diferente é pessoa diferente.
function mesmaPessoa(pendente, destino) {
  const codigo = codigoNormal(destino.codigo);
  const agencia = normalizar(pendente.agencia);
  const mesmaAgencia = agencia && [destino.agencia, destino.empresa].some((a) => normalizar(a) === agencia);
  if (codigo && codigoNormal(pendente.codigo) === codigo && mesmaAgencia) return true;
  const outroCodigo = codigo && codigoNormal(pendente.codigo) && codigoNormal(pendente.codigo) !== codigo;
  return !outroCodigo && nomeNormal(pendente.nome) !== '' && nomeNormal(pendente.nome) === nomeNormal(destino.nome);
}

// Depois de salvar (tela) ou importar (cadastro) o promotor "destino", liga a ele os pendentes que são a mesma
// pessoa. Devolve [{ nome, agencia, atendimentos }] dos que foram ligados.
async function ligarPendentesDe(rodar, destinoId) {
  const [destino] = await rodar('SELECT * FROM promotores WHERE id = $1', [destinoId]);
  if (!destino) return [];
  const pendentes = await rodar("SELECT * FROM promotores WHERE pendente <> '' AND id <> $1 ORDER BY id FOR UPDATE", [destinoId]);
  const ligados = [];
  for (const pendente of pendentes.filter((p) => mesmaPessoa(p, destino))) {
    ligados.push({ nome: pendente.nome, agencia: pendente.agencia, atendimentos: await ligarDentro(rodar, pendente, destino) });
  }
  return ligados;
}

module.exports = { ligarDentro, ligarPendentesDe, mesmaPessoa, nomeNormal };
