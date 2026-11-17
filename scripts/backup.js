// npm run backup
// Copia o banco inteiro (DATABASE_URL do .env) para backups/promotor-AAAA-MM-DD_HHMM.dump.
// O arquivo é do formato do pg_dump ("custom"): volta com "npm run restaurar -- <arquivo>".
const fs = require('fs');
const path = require('path');
const { conexao, rodar } = require('./banco');

const { descricao, env } = conexao();
const pasta = path.join(__dirname, '..', 'backups');
fs.mkdirSync(pasta, { recursive: true });
const agora = new Date();
const doisDigitos = (n) => String(n).padStart(2, '0');
const carimbo = `${agora.getFullYear()}-${doisDigitos(agora.getMonth() + 1)}-${doisDigitos(agora.getDate())}_${doisDigitos(agora.getHours())}${doisDigitos(agora.getMinutes())}`;
const arquivo = path.join(pasta, `promotor-${carimbo}.dump`);

console.log(`Copiando o banco ${descricao}...`);
const status = rodar('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${arquivo}`], env);
if (status !== 0) {
  fs.rmSync(arquivo, { force: true }); // não deixa um arquivo pela metade
  console.error('\nO backup falhou (veja a mensagem acima). Nada foi gravado.');
  process.exit(status || 1);
}
const tamanho = (fs.statSync(arquivo).size / 1048576).toFixed(1).replace('.', ',');
console.log(`Backup pronto: ${path.relative(process.cwd(), arquivo)} (${tamanho} MB).`);
console.log('Guarde uma cópia fora do computador (ex.: Google Drive da empresa). O arquivo tem dados da empresa: não envie por e-mail aberto.');
