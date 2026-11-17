// Partes comuns dos scripts de backup e restauração: lê o DATABASE_URL do .env e transforma nas variáveis
// que o pg_dump e o pg_restore entendem. Assim a senha não aparece na linha de comando.
require('dotenv').config({ quiet: true });
const { spawnSync } = require('child_process');

function conexao() {
  const texto = process.env.DATABASE_URL;
  if (!texto) {
    console.error('Falta o DATABASE_URL no arquivo .env (o endereço do banco PostgreSQL).');
    process.exit(1);
  }
  let url;
  try {
    url = new URL(texto);
  } catch {
    console.error('O DATABASE_URL do .env não é um endereço válido (formato: postgres://usuario:senha@servidor:5432/banco).');
    process.exit(1);
  }
  const banco = decodeURIComponent(url.pathname.replace(/^\//, ''));
  // O banco do Render exige conexão segura (SSL) quando acessado de fora.
  const ssl = url.searchParams.get('sslmode') || (url.hostname.endsWith('render.com') ? 'require' : 'prefer');
  return {
    descricao: `${banco} em ${url.hostname}`, // sem usuário nem senha, para poder aparecer na tela
    banco,
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: banco,
      PGSSLMODE: ssl,
    },
  };
}

// Roda pg_dump / pg_restore e explica o erro mais comum: a ferramenta não está instalada.
function rodar(programa, argumentos, env) {
  const r = spawnSync(programa, argumentos, { env, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    console.error(`\nNão encontrei o programa "${programa}". Ele vem com o PostgreSQL:`);
    console.error('  - Windows: instale o PostgreSQL (postgresql.org/download) marcando "Command Line Tools" e reabra o terminal;');
    console.error('  - Linux: sudo apt install postgresql-client.');
    console.error('Use a versão igual ou maior que a do banco (o banco do Render é PostgreSQL 16).');
    process.exit(1);
  }
  return r.status;
}

module.exports = { conexao, rodar };
