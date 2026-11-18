@echo off
rem Backup do Controle de Promotores, chamado pelo Agendador de Tarefas do Windows (ver "npm run agendar-backup").
rem Vai para a pasta do projeto (a pasta acima de "scripts"), roda o backup e guarda a saida em backups\ultima-execucao.txt.
cd /d "%~dp0.."
if not exist backups mkdir backups
node scripts\backup.js > backups\ultima-execucao.txt 2>&1
exit /b %errorlevel%
