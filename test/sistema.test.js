// Teste do sistema inteiro (login, importação, cálculo e permissões) usando um banco de testes.
// Só roda se a variável DATABASE_URL_TESTE estiver definida. ATENÇÃO: ele APAGA os dados desse banco.
//   DATABASE_URL_TESTE=postgres://usuario:senha@localhost:5432/promotor_teste npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const urlTeste = process.env.DATABASE_URL_TESTE;

test('sistema completo', { skip: urlTeste ? false : 'defina DATABASE_URL_TESTE para rodar' }, async (t) => {
  process.env.DATABASE_URL = urlTeste;
  const { consulta, iniciarBanco, fecharBanco } = require('../src/db');
  const auth = require('../src/auth');
  const { criarApp } = require('../src/app');
  const { montarPlanilha, analisar, criarAgrupador } = require('../src/planilha');

  await consulta('DROP TABLE IF EXISTS visitas, faturamento, importacoes, promotores, lojas, usuarios CASCADE');
  await iniciarBanco();
  await auth.criarUsuario({ login: 'suporte', nome: 'Suporte', senha: 'senha-suporte', perfil: 'suporte' });
  await auth.criarUsuario({ login: 'regis', nome: 'Regis', senha: 'senha-regis', perfil: 'usuario' });

  const servidor = criarApp().listen(0);
  const base = `http://localhost:${servidor.address().port}`;
  t.after(async () => { servidor.close(); await fecharBanco(); });

  // Pequeno "navegador": guarda o cookie do login e manda nas chamadas seguintes.
  const sessao = () => {
    let cookie = '';
    return async (caminho, opcoes = {}) => {
      const headers = { ...(opcoes.headers || {}), cookie };
      if (opcoes.json) { headers['content-type'] = 'application/json'; opcoes.body = JSON.stringify(opcoes.json); }
      const r = await fetch(base + caminho, { ...opcoes, headers });
      const novos = r.headers.getSetCookie();
      if (novos.length) cookie = novos.map((c) => c.split(';')[0]).join('; ');
      return { status: r.status, dados: await r.json().catch(() => null) };
    };
  };
  // Faz o mesmo caminho da tela Importar: converte o .xlsx, reconhece as colunas, soma as linhas e manda gravar.
  const importar = async (chamar, tipo, arquivo, opcoes = {}) => {
    const { abas } = (await chamar('/api/importar/converter', { method: 'POST', body: arquivo, headers: { 'content-type': 'application/octet-stream' } })).dados;
    const analise = analisar(abas[0].linhas, tipo);
    const agrupador = criarAgrupador(tipo, analise.mapa, opcoes);
    abas[0].linhas.slice(analise.linhaCabecalho + 1).forEach(agrupador.adicionar);
    return (await chamar('/api/importar/gravar', { method: 'POST', json: { tipo, arquivo: 'dados.xlsx', ...agrupador.resultado() } })).dados;
  };

  const anonimo = sessao();
  assert.equal((await anonimo('/api/resumo?de=2026-10&ate=2026-10')).status, 401);
  assert.equal((await anonimo('/api/login', { method: 'POST', json: { login: 'suporte', senha: 'errada' } })).status, 401);

  const suporte = sessao();
  assert.equal((await suporte('/api/login', { method: 'POST', json: { login: 'suporte', senha: 'senha-suporte' } })).status, 200);
  const regis = sessao();
  await regis('/api/login', { method: 'POST', json: { login: 'regis', senha: 'senha-regis' } });

  await t.test('usuário comum importa, mas não administra usuários', async () => {
    assert.equal((await regis('/api/usuarios')).status, 403);
    assert.equal((await regis('/api/usuarios', { method: 'POST', json: { login: 'x12', nome: 'X', senha: '12345678', perfil: 'suporte' } })).status, 403);
    assert.equal((await suporte('/api/usuarios')).dados.length, 2);
  });

  await t.test('importa visitas no formato da agência e faturamento, e calcula os 3%', async () => {
    const visitas = await montarPlanilha('Sistematica', [
      { titulo: 'Estabelecimento', chave: 'loja' }, { titulo: 'Estab. CNPJ', chave: 'cnpj' },
      { titulo: 'Vis. Mes', chave: 'vis' }, { titulo: 'Vlr Mes', chave: 'vlr' },
    ], [
      { loja: 'Mercado Um', cnpj: '11222333000181', vis: 4, vlr: 100 },
      { loja: 'Mercado Dois', cnpj: '22222333000106', vis: 4, vlr: 100 },
      { loja: '', cnpj: '', vis: 'TOTAL', vlr: 200 },
    ]);
    const opcoes = { mes: '2026-10', promotorNovo: { nome: 'Agência Teste', tipo: 'AGENCIA' } };
    const r1 = await importar(regis, 'visitas', visitas, opcoes);
    assert.equal(r1.importadas, 2);
    assert.equal(r1.ignoradas, 1);
    assert.equal(r1.promotoresNovos, 1);
    // Importar o mesmo arquivo de novo não pode duplicar.
    const r2 = await importar(regis, 'visitas', visitas, opcoes);
    assert.equal(r2.promotoresNovos, 0);
    assert.equal(r2.lojasNovas, 0);

    const fat = await montarPlanilha('Fat', [
      { titulo: 'Cliente', chave: 'c' }, { titulo: 'CNPJ', chave: 'cnpj' }, { titulo: 'Emissão', chave: 'd' }, { titulo: 'Valor Total', chave: 'v' },
    ], [
      { c: 'MERCADO UM LTDA', cnpj: '11.222.333/0001-81', d: '05/10/2026', v: 6000 },
      { c: 'MERCADO UM LTDA', cnpj: '11.222.333/0001-81', d: '20/10/2026', v: 4000 },
      { c: 'MERCADO DOIS LTDA', cnpj: '22.222.333/0001-06', d: '10/10/2026', v: 1000 },
    ]);
    const r3 = await importar(regis, 'faturamento', fat);
    assert.equal(r3.importadas, 2); // duas lojas (as duas notas do Mercado Um foram somadas)
    assert.equal(r3.lojasNovas, 0); // achou as lojas pelo CNPJ
    await importar(regis, 'faturamento', fat); // repetir não soma em dobro

    const resumo = (await regis('/api/resumo?de=2026-10&ate=2026-10')).dados;
    assert.equal(resumo.faturamentoTotal, 11000);
    assert.equal(resumo.custoTotal, 200);
    assert.equal(resumo.dentro, 1); // 200 / 11000 = 1,82%
    assert.equal(resumo.fora, 0);

    const lista = (await regis('/api/promotores?de=2026-10&ate=2026-10')).dados.promotores;
    const detalhe = (await regis(`/api/promotores/${lista[0].id}?de=2026-10&ate=2026-10`)).dados;
    assert.equal(detalhe.lojas.find((l) => l.loja.cnpj === '11222333000181').situacao, 'dentro'); // 1%
    assert.equal(detalhe.lojas.find((l) => l.loja.cnpj === '22222333000106').situacao, 'fora'); // 10%

    const fora = (await regis('/api/faturamento?de=2026-10&ate=2026-10&situacao=fora')).dados.lojas;
    assert.equal(fora.length, 1);

    // Ficha da loja (abre ao clicar numa loja em Faturamento): faturamento mês a mês e quem atende.
    const ficha = (await regis(`/api/lojas/${fora[0].loja.id}?de=2026-09&ate=2026-10`)).dados;
    assert.equal(ficha.loja.cnpj, '22222333000106');
    assert.deepEqual(ficha.porMes.map((m) => [m.mes, m.faturamento, m.custo, m.situacao]), [['2026-10', 1000, 100, 'fora']]);
    assert.deepEqual(ficha.promotores.map((p) => [p.nome, p.custo, p.percentual]), [['Agência Teste', 100, 10]]);
    assert.equal((await regis('/api/lojas/999999?de=2026-10&ate=2026-10')).status, 404);
  });

  await t.test('o servidor confere os dados da importação e não grava nada pela metade', async () => {
    const gravar = (itens) => regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'faturamento', arquivo: 'x', itens } });
    const bom = { loja: { nome: 'Mercado Três', cnpj: '33333444000106' }, mes: '2026-10', empresa: '', valor: 500 };
    assert.equal((await gravar([bom, { ...bom, valor: 'abc' }])).status, 400);
    assert.equal((await gravar([bom, { ...bom, mes: '2026-13' }])).status, 400);
    assert.equal((await gravar([bom, { ...bom, loja: { nome: '', cnpj: '' } }])).status, 400);
    assert.equal((await gravar([])).status, 400);
    assert.equal((await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'outro', itens: [bom] } })).status, 400);
    // Como todas as tentativas falharam, o "Mercado Três" não pode ter sido cadastrado.
    const [{ total }] = await consulta("SELECT count(*)::int AS total FROM lojas WHERE cnpj = '33333444000106'");
    assert.equal(total, 0);
  });

  await t.test('modelo padrão: atendimentos de CLT + cadastro com salário se encontram pelo código', async () => {
    const gravar = (tipo, itens) => regis('/api/importar/gravar', { method: 'POST', json: { tipo, arquivo: 'modelo.xlsx', itens } });
    const loja = (nome) => ({ nome, cnpj: '', cidade: 'Curitiba', uf: 'PR' });
    // 1º) Atendimentos: a planilha traz só o primeiro nome e o código, sem valor por loja.
    const maria = { nome: 'MARIA', tipo: 'CLT', agencia: 'Filial PR (CLT)', codigo: '30' };
    const r1 = (await gravar('visitas', [
      { promotor: maria, loja: loja('Condor A'), mes: '2026-10', visitas: 0, custo: null, dias: 'Seg' },
      { promotor: maria, loja: loja('Condor B'), mes: '2026-10', visitas: 0, custo: null, dias: 'Qua' },
      // Outra pessoa com o mesmo código (de outra empresa) não pode ser confundida com a Maria.
      { promotor: { nome: 'PEDRO', tipo: 'CLT', agencia: 'Outra filial', codigo: '30' }, loja: loja('Condor C'), mes: '2026-10', visitas: 0, custo: null },
    ])).dados;
    assert.equal(r1.promotoresNovos, 2);
    // 2º) Cadastro: nome completo, mesmo código. Tem que atualizar a Maria que já existe, não criar outra.
    const custos = { salario: 2000, periculosidade: 600, ajuda_celular: 50, ajuda_custo: 600, almoco: 0, vale_transporte: 400, gratificacao: 0, outros_custos: 0 };
    const r2 = (await gravar('promotores', [
      { nome: 'Maria Aparecida de Souza', codigo: '30', tipo: 'CLT', empresa: '101 FILIAL PARANÁ', admissao: '2026-02-01', regiao: 'Curitiba', ...custos },
      { nome: 'Carlos Sem Loja', codigo: '77', tipo: 'CLT', empresa: 'GRUBAL SC', admissao: '2025-01-27', regiao: 'Joinville', ...custos },
    ])).dados;
    assert.deepEqual([r2.promotoresNovos, r2.promotoresAtualizados, r2.total], [1, 1, 7300]);

    const lista = (await regis('/api/promotores?de=2026-10&ate=2026-10&tipo=CLT')).dados.promotores;
    const m = lista.find((p) => p.codigo === '30' && p.nome.startsWith('Maria'));
    assert.equal(m.nome, 'Maria Aparecida de Souza');
    assert.equal(m.agencia, 'Filial PR (CLT)'); // manteve a agência que veio dos atendimentos
    assert.equal(m.qtdLojas, 2);
    assert.equal(m.custo, 3650); // salário + adicionais, dividido entre as duas lojas
    assert.equal(m.situacao, 'sem_faturamento'); // lojas sem CNPJ não ligam com o faturamento do Focco
    const detalhe = (await regis(`/api/promotores/${m.id}?de=2026-10&ate=2026-10`)).dados;
    assert.deepEqual(detalhe.lojas.map((l) => [l.custo, l.dias]).sort(), [[1825, 'Qua'], [1825, 'Seg']]);
    // Carlos tem salário mas nenhuma loja lançada: o custo aparece, marcado como "sem lojas".
    const carlos = lista.find((p) => p.codigo === '77');
    assert.deepEqual([carlos.custo, carlos.qtdLojas, carlos.situacao], [3650, 0, 'sem_lojas']);
    assert.equal(lista.filter((p) => p.nome === 'PEDRO').length, 1);
    // Repetir o cadastro não duplica ninguém.
    const r3 = (await gravar('promotores', [{ nome: 'Maria Aparecida de Souza', codigo: '30', tipo: 'CLT', ...custos }])).dados;
    assert.deepEqual([r3.promotoresNovos, r3.promotoresAtualizados], [0, 1]);
  });

  await t.test('reiniciar o sistema com dados já gravados não dá erro', async () => {
    // Dois promotores com o mesmo nome, de agências diferentes (acontece na planilha real).
    const gravar = (agencia) => regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'visitas', arquivo: 'x', itens: [
      { promotor: { nome: 'JOAO', tipo: 'AGENCIA', agencia }, loja: { nome: 'Loja do João', cnpj: '', cidade: agencia }, mes: '2026-10', visitas: 1, custo: 10 },
    ] } });
    assert.equal((await gravar('Agência A')).status, 200);
    assert.equal((await gravar('Agência B')).status, 200);
    // "iniciarBanco" roda toda vez que o servidor liga. Tem que funcionar com as tabelas já cheias.
    await iniciarBanco();
    await iniciarBanco();
  });

  await t.test('endereço ou corpo inválido responde 400, sem revelar detalhes do banco', async () => {
    const periodo = 'de=2026-10&ate=2026-10';
    for (const caminho of [`/api/lojas/abc?${periodo}`, `/api/lojas/99999999999999999999?${periodo}`, `/api/lojas/-1?${periodo}`, `/api/lojas/0?${periodo}`,
      `/api/promotores/abc?${periodo}`, `/api/promotores/1.5?${periodo}`]) {
      const r = await regis(caminho);
      assert.equal(r.status, 400, caminho);
      assert.doesNotMatch(r.dados.erro, /integer|syntax|range|NaN|column|relation/i, caminho);
    }
    assert.equal((await regis('/api/visitas/abc', { method: 'DELETE' })).status, 400);
    assert.equal((await suporte('/api/usuarios/abc', { method: 'DELETE' })).status, 400);
    // Corpo que não é JSON (ou vazio) não pode derrubar a rota.
    const texto = { method: 'POST', body: 'senhaAtual=x', headers: { 'content-type': 'text/plain' } };
    assert.equal((await regis('/api/conta/senha', texto)).status, 400);
    assert.equal((await regis('/api/conta/senha', { method: 'POST' })).status, 400);
    assert.equal((await regis('/api/promotores', texto)).status, 400);
    assert.equal((await regis('/api/visitas', texto)).status, 400);
    assert.equal((await regis('/api/importar/gravar', texto)).status, 400);
    assert.equal((await regis('/api/importar/converter', texto)).status, 400);
    assert.equal((await regis('/api/conta/senha', { method: 'POST', body: '{quebrado', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await regis('/api/visitas', { method: 'POST', json: { promotorId: 99999999999999999999, lojaId: 'x', mes: '2026-10', visitas: 1 } })).status, 400);
    assert.equal((await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'visitas', itens: [null] } })).status, 400);
    assert.equal((await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'faturamento', itens: [{ loja: null, mes: '2026-10', valor: 1 }] } })).status, 400);
  });

  await t.test('erro inesperado devolve só a mensagem genérica', async () => {
    const original = console.error;
    const registrado = [];
    console.error = (...partes) => registrado.push(partes);
    try {
      // "empresa" com um caractere que o banco não aceita provoca um erro de verdade no PostgreSQL.
      const r = await regis('/api/faturamento?de=2026-10&ate=2026-10&empresa=%00');
      assert.equal(r.status, 500);
      assert.match(r.dados.erro, /^Erro interno\. Tente de novo; se continuar, avise o suporte e informe o código [0-9A-Z]+\.$/);
      assert.equal(registrado.length, 1); // o detalhe foi para o log do servidor
    } finally {
      console.error = original;
    }
  });

  await t.test('as telas só abrem com login; a de Usuários, só para o suporte', async () => {
    const abrir = (chamar, caminho) => chamar(caminho, { redirect: 'manual' });
    for (const tela of ['/resumo', '/faturamento', '/loja', '/promotores', '/promotor', '/importar', '/usuarios', '/conta', '/usuarios.html', '/resumo/']) {
      const r = await fetch(base + tela, { redirect: 'manual' });
      assert.deepEqual([r.status, r.headers.get('location')], [302, '/login'], tela);
    }
    assert.equal((await fetch(`${base}/login`, { redirect: 'manual' })).status, 200);
    assert.equal((await fetch(`${base}/css/estilo.css`)).status, 200); // o visual do login continua acessível
    assert.equal((await abrir(regis, '/resumo')).status, 200);
    assert.equal((await abrir(regis, '/usuarios')).status, 302);
    assert.equal((await abrir(suporte, '/usuarios')).status, 200);
    assert.equal((await abrir(suporte, '/login')).status, 302); // já logado: vai direto para o sistema
  });

  await t.test('desfazer importação apaga só o que veio dela; excluir promotor leva os atendimentos', async () => {
    const item = (valor) => ({ loja: { nome: 'Loja Desfazer', cnpj: '', cidade: 'X' }, mes: '2026-07', empresa: '', valor });
    await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'faturamento', arquivo: 'a', itens: [item(100)] } });
    const antes = (await regis('/api/importacoes')).dados[0];
    assert.equal(antes.total, 100);
    assert.equal((await regis('/api/faturamento?de=2026-07&ate=2026-07')).dados.totais.faturamento, 100);
    const r = await regis(`/api/importacoes/${antes.id}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.dados.registros], [200, 1]);
    assert.equal((await regis('/api/faturamento?de=2026-07&ate=2026-07')).dados.totais.faturamento, 0);
    assert.equal((await regis(`/api/importacoes/${antes.id}`, { method: 'DELETE' })).status, 404);

    const pedro = (await regis('/api/promotores?de=2026-10&ate=2026-10&busca=PEDRO')).dados.promotores[0];
    assert.equal(pedro.qtdLojas, 1);
    assert.equal((await regis(`/api/promotores/${pedro.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await regis('/api/promotores?de=2026-10&ate=2026-10&busca=PEDRO')).dados.promotores.length, 0);
    assert.equal((await regis(`/api/promotores/${pedro.id}`, { method: 'DELETE' })).status, 404);
  });

  await t.test('o sistema não fica sem suporte', async () => {
    const [eu] = (await suporte('/api/usuarios')).dados.filter((u) => u.login === 'suporte');
    assert.equal((await suporte(`/api/usuarios/${eu.id}`, { method: 'PUT', json: { perfil: 'usuario' } })).status, 400);
    assert.equal((await suporte(`/api/usuarios/${eu.id}`, { method: 'DELETE' })).status, 400);
  });

  await t.test('usuário desativado perde o acesso na hora', async () => {
    const [r] = (await suporte('/api/usuarios')).dados.filter((u) => u.login === 'regis');
    await suporte(`/api/usuarios/${r.id}`, { method: 'PUT', json: { ativo: false } });
    assert.equal((await regis('/api/resumo?de=2026-10&ate=2026-10')).status, 401);
  });

  // Este é o último teste de propósito: ele bloqueia o IP da máquina de testes.
  await t.test('bloqueio de login: por login (5 erros) e por IP (20 erros, mesmo trocando de login)', async () => {
    const tentar = (login, senha = 'senha-errada') => anonimo('/api/login', { method: 'POST', json: { login, senha } });
    // O login certo do suporte, lá no começo, zerou a contagem dele. 5 erros seguidos bloqueiam;
    // a tentativa seguinte é barrada mesmo com a senha certa.
    for (let i = 0; i < 5; i++) assert.equal((await tentar('suporte')).status, 401);
    assert.equal((await tentar('suporte', 'senha-suporte')).status, 429);
    // A mesma senha testada em logins diferentes. Este IP já errou 6 vezes (1 no começo + 5 agora); o limite é 20.
    for (let i = 0; i < 14; i++) assert.equal((await tentar(`login-inventado-${i}`)).status, 401);
    assert.equal((await tentar('outro-login-qualquer')).status, 429);
  });
});
