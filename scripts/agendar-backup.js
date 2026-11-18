// npm run agendar-backup                     -> toda segunda-feira às 12:00
// npm run agendar-backup -- SEX 17:30        -> escolhe o dia (SEG, TER, QUA, QUI, SEX, SAB, DOM) e a hora
//
// Cria (ou atualiza, se já existir) no Agendador de Tarefas do Windows a tarefa que roda
// scripts\backup-agendado.cmd toda semana. Só funciona no Windows.
// A tarefa roda com o seu usuário e só quando você está logado no computador: se o computador estiver
// desligado ou sem ninguém logado na hora marcada, o Windows roda assim que possível (opção "StartWhenAvailable").
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const NOME = 'Controle de Promotores - backup semanal';
const DIAS = { SEG: 'MON', TER: 'TUE', QUA: 'WED', QUI: 'THU', SEX: 'FRI', SAB: 'SAT', DOM: 'SUN' };

if (process.platform !== 'win32') {
  console.error('Este comando é só para Windows (usa o Agendador de Tarefas).');
  console.error('No Linux, agende com o cron. Ex.: "crontab -e" e acrescente a linha:');
  console.error(`  0 12 * * 1 cd ${path.join(__dirname, '..')} && node scripts/backup.js >> backups/ultima-execucao.txt 2>&1`);
  process.exit(1);
}

const [diaTexto = 'SEG', hora = '12:00'] = process.argv.slice(2);
const dia = DIAS[diaTexto.toUpperCase()];
if (!dia) {
  console.error(`Dia inválido: "${diaTexto}". Use SEG, TER, QUA, QUI, SEX, SAB ou DOM.`);
  process.exit(1);
}
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
  console.error(`Hora inválida: "${hora}". Use o formato HH:MM (ex.: 09:30).`);
  process.exit(1);
}

const script = path.join(__dirname, 'backup-agendado.cmd');
if (!fs.existsSync(path.join(__dirname, '..', '.env'))) {
  console.error('Não achei o arquivo .env na pasta do projeto. Configure o DATABASE_URL antes de agendar.');
  process.exit(1);
}

// A tarefa é criada por um XML para poder ligar a opção "rodar assim que possível se perdeu o horário".
const [ano, mes, diaDoMes] = new Date().toISOString().slice(0, 10).split('-');
const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Backup semanal do banco do Controle de Promotores (npm run backup).</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${ano}-${mes}-${diaDoMes}T${hora}:00</StartBoundary>
      <ScheduleByWeek><DaysOfWeek><${{ MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' }[dia]} /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec><Command>"${script}"</Command></Exec>
  </Actions>
</Task>`;
const arquivoXml = path.join(os.tmpdir(), 'controle-promotores-backup.xml');
fs.writeFileSync(arquivoXml, `﻿${xml}`, 'utf16le');

const r = spawnSync('schtasks', ['/Create', '/F', '/TN', NOME, '/XML', arquivoXml], { stdio: 'inherit' });
fs.rmSync(arquivoXml, { force: true });
if (r.error || r.status !== 0) {
  console.error('\nNão consegui criar a tarefa (veja a mensagem acima).');
  process.exit(r.status || 1);
}
console.log(`\nTarefa "${NOME}" agendada: toda ${diaTexto.toUpperCase()} às ${hora}.`);
console.log('Para testar agora:   schtasks /Run /TN "' + NOME + '"');
console.log('Para ver o resultado: abra backups\\ultima-execucao.txt e o backup.log na pasta de backup.');
console.log('Para remover:         schtasks /Delete /TN "' + NOME + '" /F');
