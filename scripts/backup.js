// npm run backup
// Copia o banco inteiro (DATABASE_URL do .env) para <pasta>/promotor-AAAA-MM-DD_HHMMSS.dump.
// O arquivo é do formato do pg_dump ("custom"): volta com "npm run restaurar -- <arquivo>".
//
// Opções no .env (todas opcionais):
//   BACKUP_PASTA=C:\Users\fulano\OneDrive - Empresa\Backups Promotores   (padrão: pasta "backups" do projeto)
//   BACKUP_MANTER_DIAS=60   apaga cópias com mais de 60 dias, mas SÓ depois de um backup novo dar certo,
//                           e SEMPRE mantém as 4 mais recentes. 0 = nunca apaga nada.
// Cada execução grava uma linha em <pasta>/backup.log (data, resultado, arquivo e tamanho; nunca a senha).
const fs = require('fs');
const path = require('path');
const { conexao, rodar } = require('./banco');

// Nomes dos backups deste sistema (os antigos tinham só hora e minuto; os novos têm segundos).
const PADRAO_ARQUIVO = /^promotor-\d{4}-\d{2}-\d{2}_\d{4}(\d{2})?(-\d+)?\.dump$/;
const SEMPRE_MANTER = 4;

const pasta = process.env.BACKUP_PASTA ? path.resolve(process.env.BACKUP_PASTA) : path.join(__dirname, '..', 'backups');
const manterDias = process.env.BACKUP_MANTER_DIAS === undefined || process.env.BACKUP_MANTER_DIAS === ''
  ? 60 : Number(process.env.BACKUP_MANTER_DIAS);
if (!Number.isInteger(manterDias) || manterDias < 0) {
  console.error('BACKUP_MANTER_DIAS no .env precisa ser um número inteiro de dias (0 = nunca apagar).');
  process.exit(1);
}

const agora = new Date();
const doisDigitos = (n) => String(n).padStart(2, '0');
const dataHora = `${agora.getFullYear()}-${doisDigitos(agora.getMonth() + 1)}-${doisDigitos(agora.getDate())} ${doisDigitos(agora.getHours())}:${doisDigitos(agora.getMinutes())}`;
const carimbo = `${dataHora.replace(' ', '_').replace(':', '')}${doisDigitos(agora.getSeconds())}`;

// Registro de cada execução, para conferir depois se o backup agendado está rodando.
function registrar(texto) {
  try {
    fs.appendFileSync(path.join(pasta, 'backup.log'), `${dataHora}  ${texto}\n`);
  } catch {
    // sem permissão na pasta: o erro principal já aparece na tela
  }
}

try {
  fs.mkdirSync(pasta, { recursive: true });
} catch (erro) {
  console.error(`Não consegui criar a pasta de backup "${pasta}": ${erro.message}`);
  process.exit(1);
}

const { descricao, env } = conexao();
// Nome final que ainda não existe (nunca sobrescreve um backup que já está na pasta).
let arquivo = path.join(pasta, `promotor-${carimbo}.dump`);
for (let n = 2; fs.existsSync(arquivo); n++) arquivo = path.join(pasta, `promotor-${carimbo}-${n}.dump`);
// O pg_dump grava num arquivo temporário; só vira o arquivo final se terminar certo.
const temporario = `${arquivo}.parcial`;

console.log(`Copiando o banco ${descricao} para ${pasta}...`);
const status = rodar('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${temporario}`], env);
if (status !== 0) {
  fs.rmSync(temporario, { force: true }); // apaga só o temporário pela metade, nunca um backup pronto
  registrar(`ERRO  o backup falhou (código ${status}). Nada foi gravado e nada foi apagado.`);
  console.error('\nO backup falhou (veja a mensagem acima). Nada foi gravado e nenhuma cópia antiga foi apagada.');
  process.exit(status || 1);
}
fs.renameSync(temporario, arquivo);
const mb = (bytes) => (bytes / 1048576).toFixed(1).replace('.', ',');
const tamanho = fs.statSync(arquivo).size;
console.log(`Backup pronto: ${arquivo} (${mb(tamanho)} MB).`);

// Limpeza: só os arquivos de backup deste sistema (pelo nome), mais velhos que o limite, e nunca as 4 mais recentes.
let apagados = [];
if (manterDias > 0) {
  const limite = Date.now() - manterDias * 24 * 60 * 60 * 1000;
  const copias = fs.readdirSync(pasta)
    .filter((nome) => PADRAO_ARQUIVO.test(nome))
    .map((nome) => ({ nome, quando: fs.statSync(path.join(pasta, nome)).mtimeMs }))
    .sort((a, b) => b.quando - a.quando); // mais recentes primeiro
  apagados = copias.slice(SEMPRE_MANTER).filter((c) => c.quando < limite).map((c) => c.nome);
  for (const nome of apagados) fs.rmSync(path.join(pasta, nome), { force: true });
  if (apagados.length) console.log(`Cópias com mais de ${manterDias} dias apagadas: ${apagados.join(', ')}.`);
}
registrar(`OK    ${path.basename(arquivo)} (${mb(tamanho)} MB)${apagados.length ? `; apagadas ${apagados.length} cópia(s) antiga(s)` : ''}`);
console.log('O arquivo tem dados da empresa: guarde em local seguro (pasta da empresa) e não envie por e-mail aberto.');
