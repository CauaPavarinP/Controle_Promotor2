// Lê as configurações do arquivo .env (ou das variáveis de ambiente do Render).
require('dotenv').config({ quiet: true });

const producao = process.env.NODE_ENV === 'production';

const config = {
  producao,
  porta: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL || '',
  // Em desenvolvimento usamos um segredo fixo só para facilitar; em produção ele é obrigatório.
  sessionSecret: process.env.SESSION_SECRET || (producao ? '' : 'segredo-apenas-para-desenvolvimento-local'),
  // Meta: o promotor pode custar no máximo este percentual do faturamento.
  meta: Number(process.env.META_PERCENTUAL) || 3,

  validar() {
    if (!config.databaseUrl) throw new Error('Falta a variável DATABASE_URL (endereço do banco PostgreSQL).');
    if (producao && config.sessionSecret.length < 32) {
      throw new Error('Em produção, SESSION_SECRET precisa ter pelo menos 32 caracteres.');
    }
  },
};

module.exports = config;
