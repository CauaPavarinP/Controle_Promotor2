// npm run restaurar -- backups/promotor-AAAA-MM-DD_HHMM.dump
// Devolve um backup para o banco do DATABASE_URL do .env. ATENÇÃO: os dados atuais desse banco são
// SUBSTITUÍDOS pelos do arquivo. Pede para digitar RESTAURAR antes de começar.
// Roda numa transação só: se der erro no meio, o banco fica como estava.
const fs = require('fs');
const readline = require('readline');
const { conexao, rodar } = require('./banco');

const arquivo = process.argv[2];
if (!arquivo || !fs.existsSync(arquivo)) {
  console.error('Informe o arquivo de backup. Exemplo:\n  npm run restaurar -- backups/promotor-2026-11-17_1030.dump');
  process.exit(1);
}

const { descricao, banco, env } = conexao();
console.log(`\nIsto vai SUBSTITUIR todos os dados do banco ${descricao}`);
console.log(`pelos dados do arquivo ${arquivo}.`);
console.log('O que estiver hoje nesse banco e não estiver no arquivo será perdido.\n');

const pergunta = readline.createInterface({ input: process.stdin, output: process.stdout });
pergunta.question('Para continuar, digite RESTAURAR: ', (resposta) => {
  pergunta.close();
  if (resposta.trim() !== 'RESTAURAR') {
    console.log('Cancelado. Nada foi alterado.');
    process.exit(0);
  }
  const status = rodar('pg_restore', [
    '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${banco}`, arquivo,
  ], env);
  if (status !== 0) {
    console.error('\nA restauração falhou (veja a mensagem acima). Como roda numa transação só, o banco ficou como estava.');
    process.exit(status || 1);
  }
  console.log('\nRestauração concluída. Reinicie o sistema (no Render: Manual Deploy > Restart) para ele usar os dados novos.');
});
