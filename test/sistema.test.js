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
  assert.equal((await anonimo('/api/login', { method: 'POST', json: { login: 'suporte', senha: 'errada' } })).status, 400);

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
      { loja: 'Mercado Um', cnpj: '11111111000111', vis: 4, vlr: 100 },
      { loja: 'Mercado Dois', cnpj: '22222222000122', vis: 4, vlr: 100 },
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
      { c: 'MERCADO UM LTDA', cnpj: '11.111.111/0001-11', d: '05/10/2026', v: 6000 },
      { c: 'MERCADO UM LTDA', cnpj: '11.111.111/0001-11', d: '20/10/2026', v: 4000 },
      { c: 'MERCADO DOIS LTDA', cnpj: '22.222.222/0001-22', d: '10/10/2026', v: 1000 },
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
    assert.equal(detalhe.lojas.find((l) => l.loja.cnpj === '11111111000111').situacao, 'dentro'); // 1%
    assert.equal(detalhe.lojas.find((l) => l.loja.cnpj === '22222222000122').situacao, 'fora'); // 10%

    const fora = (await regis('/api/faturamento?de=2026-10&ate=2026-10&situacao=fora')).dados.lojas;
    assert.equal(fora.length, 1);
  });

  await t.test('o servidor confere os dados da importação e não grava nada pela metade', async () => {
    const gravar = (itens) => regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'faturamento', arquivo: 'x', itens } });
    const bom = { loja: { nome: 'Mercado Três', cnpj: '33333333000133' }, mes: '2026-10', empresa: '', valor: 500 };
    assert.equal((await gravar([bom, { ...bom, valor: 'abc' }])).status, 400);
    assert.equal((await gravar([bom, { ...bom, mes: '2026-13' }])).status, 400);
    assert.equal((await gravar([bom, { ...bom, loja: { nome: '', cnpj: '' } }])).status, 400);
    assert.equal((await gravar([])).status, 400);
    assert.equal((await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'outro', itens: [bom] } })).status, 400);
    // Como todas as tentativas falharam, o "Mercado Três" não pode ter sido cadastrado.
    const [{ total }] = await consulta("SELECT count(*)::int AS total FROM lojas WHERE cnpj = '33333333000133'");
    assert.equal(total, 0);
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
});
