// Rotas do sistema: páginas (pasta public) e API (tudo que começa com /api).
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const { consulta } = require('./db');
const auth = require('./auth');
const relatorios = require('./relatorios');
const planilha = require('./planilha');
const { gravarFaturamento, gravarVisitas, ErroDeImportacao } = require('./importar');

const ROTULO_SITUACAO = {
  dentro: 'Dentro da meta', fora: 'Fora da meta', sem_faturamento: 'Sem faturamento', sem_dados: 'Sem dados', sem_promotor: 'Sem promotor',
};
const ROTULO_TIPO = { CLT: 'CLT', MEI: 'MEI', AGENCIA: 'Agência' };

function criarApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // o Render fica na frente do sistema; isso faz o cookie seguro e o IP funcionarem

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.use(cookieSession({
    name: 'sessao',
    secret: config.sessionSecret,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.producao,
    maxAge: 12 * 60 * 60 * 1000, // 12 horas
  }));
  // Limite pequeno para as chamadas comuns; a gravação da importação tem o seu próprio limite, maior.
  const jsonPequeno = express.json({ limit: '200kb' });
  app.use((req, res, next) => (req.path === '/api/importar/gravar' ? next() : jsonPequeno(req, res, next)));

  app.get('/', (req, res) => res.redirect('/resumo'));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---------- Login ----------
  app.post('/api/login', async (req, res) => {
    const usuario = await auth.entrar(req.body.login, req.body.senha, req.ip);
    req.session = { usuarioId: usuario.id };
    res.json(usuario);
  });
  app.post('/api/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  // Daqui para baixo, tudo exige login.
  const api = express.Router();
  api.use(auth.exigirLogin);
  app.use('/api', api);

  api.get('/eu', (req, res) => res.json(req.usuario));
  api.get('/opcoes', async (req, res) => res.json(await relatorios.opcoes()));
  api.post('/conta/senha', async (req, res) => {
    await auth.trocarPropriaSenha(req.usuario.id, req.body.senhaAtual, req.body.senhaNova);
    res.json({ ok: true });
  });

  // ---------- Resumo, faturamento e promotores ----------
  api.get('/resumo', async (req, res) => res.json(await relatorios.resumo(req.query)));
  api.get('/faturamento', async (req, res) => res.json(await relatorios.faturamentoPorLoja(req.query)));
  api.get('/promotores', async (req, res) => res.json(await relatorios.listaDePromotores(req.query)));

  api.get('/promotores/:id', async (req, res) => {
    const detalhe = await relatorios.detalheDoPromotor(Number(req.params.id), req.query);
    if (!detalhe) return res.status(404).json({ erro: 'Promotor não encontrado.' });
    res.json(detalhe);
  });
  api.post('/promotores', async (req, res) => res.json({ id: await relatorios.salvarPromotor(null, req.body) }));
  api.put('/promotores/:id', async (req, res) => res.json({ id: await relatorios.salvarPromotor(Number(req.params.id), req.body) }));

  api.post('/visitas', async (req, res) => {
    await relatorios.salvarVisita(req.body);
    res.json({ ok: true });
  });
  api.delete('/visitas/:id', async (req, res) => {
    await consulta('DELETE FROM visitas WHERE id = $1', [Number(req.params.id) || 0]);
    res.json({ ok: true });
  });

  // ---------- Exportar para Excel ----------
  const enviarPlanilha = async (res, nome, colunas, linhas) => {
    const arquivo = await planilha.montarPlanilha(nome, colunas, linhas);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${nome}.xlsx"`,
    });
    res.send(arquivo);
  };
  const REAIS = '#,##0.00';
  const pct = (valor) => (valor === null ? null : Math.round(valor * 100) / 100);

  api.get('/faturamento/exportar', async (req, res) => {
    const { lojas } = await relatorios.faturamentoPorLoja(req.query);
    await enviarPlanilha(res, `faturamento-${req.query.de}-a-${req.query.ate}`, [
      { titulo: 'Loja', chave: 'loja', largura: 50 }, { titulo: 'CNPJ', chave: 'cnpj', largura: 20 },
      { titulo: 'Cidade', chave: 'cidade' }, { titulo: 'UF', chave: 'uf', largura: 12 },
      { titulo: 'Faturamento', chave: 'faturamento', formato: REAIS }, { titulo: 'Visitas', chave: 'visitas', largura: 10 },
      { titulo: 'Custo promotores', chave: 'custo', formato: REAIS }, { titulo: '% custo', chave: 'percentual', formato: '0.00' },
      { titulo: 'Situação', chave: 'situacao' },
    ], lojas.map((l) => ({
      loja: l.loja.nome, cnpj: l.loja.cnpj || '', cidade: l.loja.cidade, uf: l.loja.uf, faturamento: l.faturamento,
      visitas: l.visitas, custo: l.custo, percentual: pct(l.percentual), situacao: ROTULO_SITUACAO[l.situacao],
    })));
  });

  api.get('/promotores-exportar', async (req, res) => {
    const { promotores } = await relatorios.listaDePromotores(req.query);
    await enviarPlanilha(res, `promotores-${req.query.de}-a-${req.query.ate}`, [
      { titulo: 'Promotor', chave: 'nome', largura: 40 }, { titulo: 'Tipo', chave: 'tipo', largura: 12 },
      { titulo: 'Agência', chave: 'agencia', largura: 25 }, { titulo: 'Lojas', chave: 'qtdLojas', largura: 10 },
      { titulo: 'Visitas', chave: 'visitas', largura: 10 }, { titulo: 'Custo', chave: 'custo', formato: REAIS },
      { titulo: 'Faturamento das lojas', chave: 'faturamento', formato: REAIS, largura: 24 },
      { titulo: '% custo', chave: 'percentual', formato: '0.00' }, { titulo: 'Situação', chave: 'situacao' },
      { titulo: 'Ativo', chave: 'ativo', largura: 10 },
    ], promotores.map((p) => ({
      ...p, tipo: ROTULO_TIPO[p.tipo], percentual: pct(p.percentual), situacao: ROTULO_SITUACAO[p.situacao], ativo: p.ativo ? 'Sim' : 'Não',
    })));
  });

  // Planilha modelo: o formato padrão para pedir às agências.
  api.get('/modelo/visitas', async (req, res) => {
    await enviarPlanilha(res, 'modelo-visitas', [
      { titulo: 'Promotor', chave: 'promotor', largura: 30 }, { titulo: 'Tipo', chave: 'tipo', largura: 12 },
      { titulo: 'Agência', chave: 'agencia', largura: 25 }, { titulo: 'Loja', chave: 'loja', largura: 45 },
      { titulo: 'CNPJ', chave: 'cnpj', largura: 20 }, { titulo: 'Cidade', chave: 'cidade' }, { titulo: 'UF', chave: 'uf', largura: 8 },
      { titulo: 'Mês', chave: 'mes', largura: 12 }, { titulo: 'Visitas', chave: 'visitas', largura: 10 },
      { titulo: 'Custo', chave: 'custo', formato: REAIS },
    ], [{
      promotor: 'Nome do promotor (exemplo, apague esta linha)', tipo: 'Agência', agencia: 'Nome da agência', loja: 'Supermercado Exemplo - Centro',
      cnpj: '00.000.000/0001-00', cidade: 'Rio Claro', uf: 'SP', mes: '10/2026', visitas: 4, custo: 127.12,
    }]);
  });

  // ---------- Importar planilhas ----------
  // Quem lê o arquivo é o NAVEGADOR (o relatório do Focco pode passar de 150 MB): ele soma as linhas
  // por loja e mês e envia para "gravar" só o resultado, que é pequeno.
  // A única exceção é o .xlsx, que o navegador não sabe abrir: ele manda para "converter" e recebe as linhas.
  const receberXlsx = express.raw({ type: 'application/octet-stream', limit: '25mb' });
  api.post('/importar/converter', receberXlsx, async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErroDeImportacao('Nenhum arquivo foi enviado.');
    try {
      res.json({ abas: await planilha.lerXlsx(req.body) });
    } catch (erro) {
      throw new ErroDeImportacao(erro.message);
    }
  });

  api.post('/importar/gravar', express.json({ limit: '50mb' }), async (req, res) => {
    const gravar = { faturamento: gravarFaturamento, visitas: gravarVisitas }[req.body.tipo];
    if (!gravar) throw new ErroDeImportacao('Tipo de importação inválido.');
    res.json(await gravar(req.body, req.usuario.nome));
  });

  api.get('/importacoes', async (req, res) => {
    res.json(await consulta('SELECT * FROM importacoes ORDER BY id DESC LIMIT 30'));
  });

  // ---------- Usuários (só o suporte) ----------
  api.get('/usuarios', auth.exigirSuporte, async (req, res) => res.json(await auth.listarUsuarios()));
  api.post('/usuarios', auth.exigirSuporte, async (req, res) => res.json(await auth.criarUsuario(req.body)));
  api.put('/usuarios/:id', auth.exigirSuporte, async (req, res) => {
    await auth.atualizarUsuario(Number(req.params.id), req.body, req.usuario);
    res.json({ ok: true });
  });
  api.delete('/usuarios/:id', auth.exigirSuporte, async (req, res) => {
    await auth.excluirUsuario(Number(req.params.id), req.usuario);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ erro: 'Endereço não encontrado.' }));

  // ---------- Erros ----------
  // Erros "esperados" (validação) voltam com a mensagem para a tela. O resto vira erro genérico e vai para o log.
  app.use((erro, req, res, next) => { // eslint-disable-line no-unused-vars
    if (erro instanceof auth.ErroDeValidacao || erro instanceof ErroDeImportacao) return res.status(400).json({ erro: erro.message });
    if (erro.type === 'entity.too.large' && req.path === '/api/importar/gravar') return res.status(413).json({ erro: 'Importação grande demais para uma vez só. Divida o arquivo por período.' });
    if (erro.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo .xlsx grande demais (máximo 25 MB). Salve como .csv e importe de novo: .csv e o .xls do Focco não têm limite.' });
    if (erro.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Dados inválidos.' });
    console.error(erro);
    // Em produção a tela mostra só uma mensagem genérica (o detalhe fica no log do servidor).
    // Rodando no computador (desenvolvimento), mostramos o detalhe para facilitar achar o problema.
    const detalhe = config.producao ? '' : ` Detalhe: ${erro.message}`;
    res.status(500).json({ erro: `Erro interno. Tente de novo; se continuar, avise o suporte.${detalhe}` });
  });

  return app;
}

module.exports = { criarApp };
