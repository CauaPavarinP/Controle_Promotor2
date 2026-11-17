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
  dentro: 'Dentro da meta', fora: 'Fora da meta', sem_faturamento: 'Sem faturamento', sem_lojas: 'Sem lojas', sem_dados: 'Sem dados',
  sem_promotor: 'Sem promotor', sem_atendimento_no_mes: 'Comprou sem atendimento', custo_nao_informado: 'Custo não informado',
  falta_faturamento: 'Falta o faturamento', sem_cnpj: 'Sem CNPJ',
  vale: 'Vale a pena', nao_vale: 'Não vale a pena',
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
  app.get(/^\/(resumo|faturamento|loja|promotores|promotor|lojas-uf|agencias|importar|usuarios|conta)(\.html)?\/?$/, async (req, res, next) => {
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
  // Cliente do ERP pelo CNPJ (só dígitos, 11 a 14).
  api.get('/clientes/:cnpj', async (req, res) => {
    if (!/^\d{11,14}$/.test(req.params.cnpj)) return res.status(400).json({ erro: 'CNPJ inválido.' });
    const detalhe = await relatorios.detalheDoCliente(req.params.cnpj, req.query);
    if (!detalhe) return res.status(404).json({ erro: 'Cliente não encontrado no faturamento do ERP.' });
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
  api.get('/lojas-uf', async (req, res) => res.json(await relatorios.lojasPorUf(req.query)));
  api.get('/agencias', async (req, res) => res.json(await relatorios.agencias(req.query)));

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
  // As exportações usam os mesmos filtros da tela e levam TODAS as linhas (não só a página que aparece).
  const enviarPasta = async (res, nome, abas) => {
    const arquivo = await planilha.montarPasta(abas);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${nome.replace(/[^\w.-]/g, '_')}.xlsx"`,
    });
    res.send(arquivo);
  };
  const enviarPlanilha = (res, nome, colunas, linhas) => enviarPasta(res, nome, [{ nome, colunas, linhas }]);
  const REAIS = '#,##0.00';
  const pct = (valor) => (valor === null || valor === undefined ? null : Math.round(valor * 100) / 100);
  const cnpjFmt = (c) => (c && c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c || '');
  const rotuloMes = (m) => `${m.slice(5)}/${m.slice(0, 4)}`;
  const situacaoTexto = (s) => ROTULO_SITUACAO[s] || s;
  const C = {
    custo: { titulo: 'Custo', chave: 'custo', formato: REAIS, largura: 14 },
    faturamento: { titulo: 'Faturamento', chave: 'faturamento', formato: REAIS, largura: 16 },
    percentual: { titulo: '% custo', chave: 'percentual', formato: '0.00', largura: 10 },
    situacao: { titulo: 'Situação', chave: 'situacao', largura: 22 },
    visitas: { titulo: 'Visitas', chave: 'visitas', largura: 9 },
  };
  const numeros = (x) => ({ ...x, percentual: pct(x.percentual), situacao: situacaoTexto(x.situacao) });

  api.get('/faturamento/exportar', async (req, res) => {
    const { lojas } = await relatorios.faturamentoPorLoja(req.query);
    await enviarPlanilha(res, `faturamento-${req.query.de}-a-${req.query.ate}`, [
      { titulo: 'Loja / cliente', chave: 'nome', largura: 50 }, { titulo: 'CNPJ', chave: 'cnpj', largura: 20 },
      { titulo: 'Cidade', chave: 'cidade' }, { titulo: 'UF', chave: 'uf', largura: 6 },
      C.faturamento, { titulo: 'Lojas no CNPJ', chave: 'lojasDoCnpj', largura: 13 }, C.visitas,
      { ...C.custo, titulo: 'Custo promotores' }, C.percentual, C.situacao,
    ], lojas.map((l) => ({ ...numeros(l), cnpj: cnpjFmt(l.cnpj), lojasDoCnpj: l.lojasDoCnpj || null })));
  });

  api.get('/promotores-exportar', async (req, res) => {
    const { promotores } = await relatorios.listaDePromotores(req.query);
    await enviarPlanilha(res, `promotores-${req.query.de}-a-${req.query.ate}`, [
      { titulo: 'Promotor', chave: 'nome', largura: 40 }, { titulo: 'Tipo', chave: 'tipo', largura: 12 },
      { titulo: 'Agência', chave: 'agencia', largura: 30 }, { titulo: 'Código', chave: 'codigo', largura: 10 },
      { titulo: 'Lojas', chave: 'qtdLojas', largura: 8 }, C.visitas, C.custo,
      { titulo: 'Custo sem loja', chave: 'custoSemLoja', formato: REAIS, largura: 14 },
      { ...C.faturamento, titulo: 'Faturamento (parte dele)', largura: 24 }, C.percentual, C.situacao,
      { titulo: 'Ativo', chave: 'ativo', largura: 8 },
    ], promotores.map((p) => ({ ...numeros(p), tipo: ROTULO_TIPO[p.tipo], ativo: p.ativo ? 'Sim' : 'Não' })));
  });

  api.get('/lojas-uf/exportar', async (req, res) => {
    const { linhas, meses } = await relatorios.lojasPorUf(req.query);
    await enviarPlanilha(res, `lojas-por-uf-${req.query.de}-a-${req.query.ate}`, [
      { titulo: 'Supervisor', chave: 'supervisor', largura: 20 }, { titulo: 'Agência', chave: 'agencia', largura: 30 },
      { titulo: 'Promotor', chave: 'promotor', largura: 26 }, { titulo: 'Tipo', chave: 'tipo', largura: 11 },
      { titulo: 'CNPJ', chave: 'cnpj', largura: 20 }, { titulo: 'Loja', chave: 'loja', largura: 40 },
      { titulo: 'Cidade', chave: 'cidade', largura: 20 }, { titulo: 'UF', chave: 'uf', largura: 6 }, C.visitas,
      ...meses.map((m) => ({ titulo: `Valor ${rotuloMes(m)}`, chave: `m_${m}`, formato: REAIS, largura: 14 })),
      { titulo: 'Total informado', chave: 'total', formato: REAIS, largura: 15 }, C.custo, C.faturamento, C.percentual, C.situacao,
    ], linhas.map((l) => ({
      ...numeros(l), tipo: ROTULO_TIPO[l.tipo] || l.tipo, cnpj: cnpjFmt(l.cnpj),
      ...Object.fromEntries(meses.map((m) => [`m_${m}`, l.valores[m] ?? null])),
    })));
  });

  api.get('/agencias/exportar', async (req, res) => {
    const { agencias: lista } = await relatorios.agencias(req.query);
    const tipos = (a) => a.tipos.map((t) => ROTULO_TIPO[t] || t).join(', ');
    await enviarPasta(res, `agencias-${req.query.de}-a-${req.query.ate}`, [
      {
        nome: 'Agências',
        colunas: [{ titulo: 'Agência', chave: 'nome', largura: 40 }, { titulo: 'Tipo', chave: 'tipo', largura: 16 },
          { titulo: 'Promotores', chave: 'qtdPromotores', largura: 11 }, { titulo: 'Lojas', chave: 'qtdLojas', largura: 8 },
          C.visitas, C.custo, C.faturamento, C.percentual, C.situacao],
        linhas: lista.map((a) => ({ ...numeros(a), tipo: tipos(a) })),
      },
      {
        nome: 'Promotores',
        colunas: [{ titulo: 'Agência', chave: 'agencia', largura: 40 }, { titulo: 'Promotor', chave: 'nome', largura: 30 },
          { titulo: 'Tipo', chave: 'tipo', largura: 11 }, { titulo: 'Lojas', chave: 'qtdLojas', largura: 8 },
          C.visitas, C.custo, C.faturamento, C.percentual, C.situacao],
        linhas: lista.flatMap((a) => a.promotores.map((p) => ({ ...numeros(p), agencia: a.nome, tipo: ROTULO_TIPO[p.tipo] || p.tipo, qtdLojas: p.lojas.length }))),
      },
      {
        nome: 'Lojas',
        colunas: [{ titulo: 'Agência', chave: 'agencia', largura: 40 }, { titulo: 'Promotor', chave: 'promotor', largura: 30 },
          { titulo: 'Loja', chave: 'loja', largura: 40 }, { titulo: 'CNPJ', chave: 'cnpj', largura: 20 },
          { titulo: 'Cidade', chave: 'cidade', largura: 20 }, { titulo: 'UF', chave: 'uf', largura: 6 },
          C.visitas, C.custo, C.faturamento, C.percentual, C.situacao],
        linhas: lista.flatMap((a) => a.promotores.flatMap((p) => p.lojas.map((l) => ({
          ...numeros(l), agencia: a.nome, promotor: p.nome, loja: l.loja.nome, cnpj: cnpjFmt(l.loja.cnpj), cidade: l.loja.cidade, uf: l.loja.uf,
        })))),
      },
    ]);
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
    const tabela = { faturamento: 'faturamento_erp', visitas: 'visitas' }[importacao.tipo];
    const apagados = tabela ? await consulta(`DELETE FROM ${tabela} WHERE importacao_id = $1 RETURNING 1`, [id]) : [];
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
