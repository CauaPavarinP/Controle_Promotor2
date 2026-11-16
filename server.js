// Ponto de entrada: prepara o banco e liga o servidor.
const config = require('./src/config');
const { iniciarBanco } = require('./src/db');
const { criarPrimeiroUsuario } = require('./src/auth');
const { criarApp } = require('./src/app');

async function iniciar() {
  config.validar();
  await iniciarBanco();
  await criarPrimeiroUsuario();
  criarApp().listen(config.porta, () => {
    console.log(`Controle de Promotores rodando na porta ${config.porta}`);
  });
}

iniciar().catch((erro) => {
  console.error('Não foi possível iniciar o sistema:', erro.message);
  process.exit(1);
});
