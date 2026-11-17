// Supervisores dos atendimentos: divide o texto da coluna "Supervisor" da planilha, acha (ou cria) cada
// supervisor e grava os vínculos na tabela visita_supervisor (um atendimento pode ter vários supervisores).
// Usado pela importação e pelo Desfazer (src/importar.js) e pela migração ao ligar o sistema (src/db.js).
// Recebe "rodar" (a função que executa SQL dentro de uma transação) para não depender de src/db.js.
const { normalizar, primeiroNome, separarSupervisores } = require('../public/js/planilha-comum');

// Grava (ou atualiza) um supervisor pelo nome sem acento. Devolve true se for novo.
async function gravarSupervisor(rodar, { nome, codigo = '', cargo = '', empresa = '' }) {
  const [r] = await rodar(
    `INSERT INTO supervisores (nome, chave, codigo, cargo, empresa) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chave) DO UPDATE SET nome = EXCLUDED.nome,
       codigo = CASE WHEN EXCLUDED.codigo <> '' THEN EXCLUDED.codigo ELSE supervisores.codigo END,
       cargo = CASE WHEN EXCLUDED.cargo <> '' THEN EXCLUDED.cargo ELSE supervisores.cargo END,
       empresa = CASE WHEN EXCLUDED.empresa <> '' THEN EXCLUDED.empresa ELSE supervisores.empresa END
     RETURNING (xmax = 0) AS novo`,
    [nome, normalizar(nome), codigo, cargo, empresa],
  );
  return r.novo;
}

// Acha o supervisor de cada nome. Regra, nesta ordem:
//   1º) chave = nome completo sem acento e minúsculo ("Jesús" = "JESUS");
//   2º) primeiro nome, mas SÓ se houver um único supervisor com ele ("Jesus" -> "JESUS ANGELS ZAPATA RIVAS");
//   3º) não achou: cria o supervisor com o nome que veio na planilha.
// Devolve o supervisor de cada chave e um relatório (quem foi criado, quem foi ligado pelo primeiro nome).
async function resolverSupervisores(rodar, nomes) {
  const cadastro = await rodar('SELECT id, nome, chave FROM supervisores ORDER BY id');
  const porChave = new Map(cadastro.map((s) => [s.chave, s]));
  const resolvidos = new Map();
  const criados = [];
  const porPrimeiroNome = [];
  for (const nome of nomes) {
    const chave = normalizar(nome);
    if (!chave || resolvidos.has(chave)) continue;
    let supervisor = porChave.get(chave);
    if (!supervisor) {
      const mesmoPrimeiro = cadastro.filter((s) => primeiroNome(s.nome) === primeiroNome(nome));
      if (mesmoPrimeiro.length === 1) {
        supervisor = mesmoPrimeiro[0];
        porPrimeiroNome.push(`${nome} → ${supervisor.nome}`);
      }
    }
    if (!supervisor) {
      [supervisor] = await rodar(
        'INSERT INTO supervisores (nome, chave) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET nome = supervisores.nome RETURNING id, nome, chave',
        [nome.trim().slice(0, 120), chave],
      );
      cadastro.push(supervisor);
      porChave.set(chave, supervisor);
      criados.push(supervisor.nome);
    }
    resolvidos.set(chave, supervisor);
  }
  return { resolvidos, criados, porPrimeiroNome };
}

// Grava os vínculos de uma lista de atendimentos: [{ visitaId, texto }]. Não duplica (chave visita + supervisor).
async function ligarAtendimentos(rodar, atendimentos) {
  const conhecidas = new Set((await rodar('SELECT chave FROM supervisores')).map((s) => s.chave));
  const comNomes = atendimentos
    .map((a) => ({ visitaId: a.visitaId, nomes: separarSupervisores(a.texto, conhecidas) }))
    .filter((a) => a.nomes.length);
  const { resolvidos, criados, porPrimeiroNome } = await resolverSupervisores(rodar, comNomes.flatMap((a) => a.nomes));
  const pares = new Map();
  for (const a of comNomes) {
    for (const nome of a.nomes) {
      const supervisor = resolvidos.get(normalizar(nome));
      pares.set(`${a.visitaId}|${supervisor.id}`, [a.visitaId, supervisor.id]);
    }
  }
  const lista = [...pares.values()];
  let gravados = 0;
  for (let i = 0; i < lista.length; i += 1000) {
    const lote = lista.slice(i, i + 1000);
    const r = await rodar(
      `INSERT INTO visita_supervisor (visita_id, supervisor_id)
       SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING RETURNING 1`,
      [lote.map((p) => p[0]), lote.map((p) => p[1])],
    );
    gravados += r.length;
  }
  return { vinculos: gravados, atendimentos: comNomes.length, criados, porPrimeiroNome };
}

module.exports = { gravarSupervisor, resolverSupervisores, ligarAtendimentos };
