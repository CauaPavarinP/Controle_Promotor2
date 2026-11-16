// Rotas do sistema: páginas (pasta public) e API (tudo que começa com /api).
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const { consulta } = require('./db');
const auth = require('./auth');
const relatorios = require('./relatorios');
const planilha = require('./planilha');
const { gravarFaturamento, gravarVisitas, gravarPromotores, ErroDeImportacao } = require('./importar');

const ROTULO_SITUACAO = {
  dentro: 'Dentro da meta', fora: 'Fora da meta', sem_faturamento: 'Sem faturamento', sem_lojas: 'Sem lojas', sem_dados: 'Sem dados', sem_promotor: 'Sem promotor',
};
const ROTULO_TIPO = { CLT: 'CLT', MEI: 'MEI', AGENCIA: 'Agência', FREELANCER: 'Freelancer' };

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

  // Formulário enviado em outro formato (ou sem corpo) chega sem "req.body". Trocamos por um objeto vazio,
  // para as validações responderem "faltou tal campo" (400) em vez de o código quebrar (500).
  // As duas rotas de importação ficam de fora porque leem o corpo do jeito delas.
  app.use((req, res, next) => {
    if (req.body === undefined && !req.path.startsWith('/api/importar/')) req.body = {};
    next();
  });

  app.get('/', (req, res) => res.redirect('/resumo'));

  // As telas só abrem para quem está logado (a de Usuários, só para o suporte). Os dados já eram protegidos
  // pela API; isto evita que alguém sem login veja até a "casca" das telas.
  app.get(/^\/(resumo|faturamento|loja|promotores|promotor|importar|usuarios|conta)(\.html)?\/?$/, async (req, res, next) => {
    const usuario = await auth.usuarioDaSessao(req);
    if (!usuario) return res.redirect('/login');
    if (req.path.startsWith('/usuarios') && usuario.perfil !== 'suporte') return res.redirect('/resumo');
    res.set('Cache-Control', 'no-store'); // não guardar a tela no navegador, para o "voltar" depois de sair não mostrá-la
    next();
  });
  app.get(/^\/login(\.html)?\/?$/, async (req, res, next) => {
    if (await auth.usuarioDaSessao(req)) return res.redirect('/resumo'); // já está logado
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---------- Login ----------
  app.post('/api/login', async (req, res) => {
    const usuario = await auth.entrar(req.body.login, req.body.senha, req.ip);
    req.session = null; // começa uma sessão nova a cada login
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

  // Todo endereço com ":id" (ex.: /api/lojas/15) passa por aqui antes. O id tem que ser um número inteiro
  // positivo que caiba na coluna do banco; "abc" ou um número gigante recebem 400 sem nem consultar o banco.
  api.param('id', (req, res, next, valor) => {
    const id = /^\d{1,10}$/.test(valor) ? Number(valor) : 0;
    if (id < 1 || id > 2147483647) return res.status(400).json({ erro: 'Endereço inválido: o código informado não é um número válido.' });
    next();
  });

  api.get('/eu', (req, res) => res.json(req.usuario));
  api.get('/opcoes', async (req, res) => res.json(await relatorios.opcoes()));
  api.get('/lojas', async (req, res) => res.json(await relatorios.listaDeLojas()));
  api.get('/lojas/:id', async (req, res) => {
    const detalhe = await relatorios.detalheDaLoja(Number(req.params.id), req.query);
    if (!detalhe) return res.status(404).json({ erro: 'Loja não encontrada.' });
    res.json(detalhe);
  });
  api.get('/promotores-nomes', async (req, res) => res.json(await relatorios.nomesDosPromotores()));
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
  api.delete('/promotores/:id', async (req, res) => {
    // Apaga o promotor e os atendimentos dele (as lojas e o faturamento continuam).
    const apagados = await consulta('DELETE FROM promotores WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!apagados.length) return res.status(404).json({ erro: 'Promotor não encontrado.' });
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
      { titulo: 'Agência', chave: 'agencia', largura: 25 }, { titulo: 'Empresa', chave: 'empresa', largura: 25 }, { titulo: 'Código', chave: 'codigo', largura: 10 },
      { titulo: 'Lojas', chave: 'qtdLojas', largura: 10 },
      { titulo: 'Visitas', chave: 'visitas', largura: 10 }, { titulo: 'Custo', chave: 'custo', formato: REAIS },
      { titulo: 'Faturamento das lojas', chave: 'faturamento', formato: REAIS, largura: 24 },
      { titulo: '% custo', chave: 'percentual', formato: '0.00' }, { titulo: 'Situação', chave: 'situacao' },
      { titulo: 'Ativo', chave: 'ativo', largura: 10 },
    ], promotores.map((p) => ({
      ...p, tipo: ROTULO_TIPO[p.tipo], percentual: pct(p.percentual), situacao: ROTULO_SITUACAO[p.situacao], ativo: p.ativo ? 'Sim' : 'Não',
    })));
  });

  // Planilhas modelo: o formato padrão para pedir às agências (mesmas colunas do "Modelo de atendimento" da 101).
  api.get('/modelo/visitas', async (req, res) => {
    await enviarPlanilha(res, 'modelo-atendimentos', [
      { titulo: 'Mês de referência', chave: 'mes', largura: 18 }, { titulo: 'Agência ou MEI', chave: 'agencia', largura: 28 },
      { titulo: 'Tipo', chave: 'tipo', largura: 12 }, { titulo: 'CNPJ da loja', chave: 'cnpj', largura: 22 },
      { titulo: 'Loja', chave: 'loja', largura: 40 }, { titulo: 'Cidade', chave: 'cidade' }, { titulo: 'UF', chave: 'uf', largura: 6 },
      { titulo: 'Promotor', chave: 'promotor', largura: 24 }, { titulo: 'Código do promotor', chave: 'codigo', largura: 20 },
      { titulo: 'Dias de visita', chave: 'dias', largura: 22 }, { titulo: 'Visitas no mês', chave: 'visitas', largura: 16 },
      { titulo: 'Valor do mês (R$)', chave: 'valor', formato: REAIS }, { titulo: 'Status', chave: 'status', largura: 12 },
      { titulo: 'Observação', chave: 'observacao', largura: 30 }, { titulo: 'Supervisor', chave: 'supervisor', largura: 20 },
    ], [{
      mes: '10/2026', agencia: 'Nome da agência (exemplo, apague esta linha)', tipo: 'Agência', cnpj: '11.222.333/0001-81', loja: 'Supermercado Exemplo - Centro',
      cidade: 'Rio Claro', uf: 'SP', promotor: 'Nome do promotor', codigo: '', dias: 'Ter, Sex (2x/semana)', visitas: 8, valor: 159.54, status: 'Ativa', observacao: '', supervisor: '',
    }]);
  });

  api.get('/modelo/promotores', async (req, res) => {
    await enviarPlanilha(res, 'modelo-cadastro-promotores', [
      { titulo: 'Empresa / grupo', chave: 'empresa', largura: 26 }, { titulo: 'Admissão', chave: 'admissao', largura: 14 },
      { titulo: 'Código', chave: 'codigo', largura: 12 }, { titulo: 'Nome', chave: 'nome', largura: 36 }, { titulo: 'Tipo', chave: 'tipo', largura: 12 },
      { titulo: 'Salário (R$)', chave: 'salario', formato: REAIS }, { titulo: 'Periculosidade', chave: 'periculosidade', formato: REAIS },
      { titulo: 'Ajuda celular', chave: 'celular', formato: REAIS }, { titulo: 'Ajuda de custo / alimentação', chave: 'ajuda', formato: REAIS, largura: 28 },
      { titulo: 'Vale transporte', chave: 'vt', formato: REAIS }, { titulo: 'Gratificação', chave: 'gratificacao', formato: REAIS },
      { titulo: 'Outros custos', chave: 'outros', formato: REAIS }, { titulo: 'Região', chave: 'regiao', largura: 20 },
    ], [{
      empresa: '101 Filial (exemplo, apague esta linha)', admissao: '01/02/2026', codigo: '123', nome: 'Nome completo do promotor', tipo: 'CLT',
      salario: 2390, periculosidade: 717, celular: 50, ajuda: 600, vt: 400, gratificacao: 0, outros: 0, regiao: 'Curitiba',
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
    const dados = req.body && typeof req.body === 'object' ? req.body : {}; // corpo que não é JSON chega vazio
    const gravar = { faturamento: gravarFaturamento, visitas: gravarVisitas, promotores: gravarPromotores }[dados.tipo];
    if (!gravar) throw new ErroDeImportacao('Tipo de importação inválido.');
    res.json(await gravar(dados, req.usuario.nome));
  });

  // Desfaz uma importação: apaga o faturamento ou os atendimentos que ela gravou e que ainda são dela
  // (o que uma importação mais nova substituiu já pertence à mais nova e não é apagado).
  // Lojas e promotores cadastrados por ela continuam no sistema.
  api.delete('/importacoes/:id', async (req, res) => {
    const id = Number(req.params.id);
    const [importacao] = await consulta('SELECT tipo FROM importacoes WHERE id = $1', [id]);
    if (!importacao) return res.status(404).json({ erro: 'Importação não encontrada.' });
    const tabela = { faturamento: 'faturamento', visitas: 'visitas' }[importacao.tipo];
    const apagados = tabela ? await consulta(`DELETE FROM ${tabela} WHERE importacao_id = $1 RETURNING id`, [id]) : [];
    await consulta('DELETE FROM importacoes WHERE id = $1', [id]);
    res.json({ ok: true, registros: apagados.length });
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
  // Erros "esperados" (validação) voltam com a mensagem para a tela. Qualquer outro erro vira uma mensagem
  // genérica: o detalhe (que pode revelar o banco e a estrutura do sistema) vai SÓ para o log do servidor,
  // junto com um código curto que a pessoa pode informar ao suporte para achar a linha no log.
  app.use((erro, req, res, next) => { // eslint-disable-line no-unused-vars
    if (erro instanceof auth.ErroDeValidacao || erro instanceof ErroDeImportacao) return res.status(erro.status || 400).json({ erro: erro.message });
    if (erro.type === 'entity.too.large' && req.path === '/api/importar/gravar') return res.status(413).json({ erro: 'Importação grande demais para uma vez só. Divida o arquivo por período.' });
    if (erro.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo .xlsx grande demais (máximo 25 MB). Salve como .csv e importe de novo: .csv e o .xls do Focco não têm limite.' });
    if (erro.status >= 400 && erro.status < 500) return res.status(400).json({ erro: 'Dados inválidos.' }); // JSON malformado, codificação errada etc.
    const codigo = Date.now().toString(36).toUpperCase();
    console.error(`[erro ${codigo}] ${req.method} ${req.path}`, erro);
    res.status(500).json({ erro: `Erro interno. Tente de novo; se continuar, avise o suporte e informe o código ${codigo}.` });
  });

  return app;
}

module.exports = { criarApp };
