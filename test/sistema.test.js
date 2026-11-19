// Teste do sistema inteiro (login, importação, cálculo e permissões) usando um banco de testes.
// Só roda se a variável DATABASE_URL_TESTE estiver definida. ATENÇÃO: ele APAGA os dados desse banco.
//   DATABASE_URL_TESTE=postgres://usuario:senha@localhost:5432/promotor_teste npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const urlTeste = process.env.DATABASE_URL_TESTE;

test('sistema completo', { skip: urlTeste ? false : 'defina DATABASE_URL_TESTE para rodar' }, async (t) => {
  process.env.DATABASE_URL = urlTeste;
  const { consulta, iniciarBanco, fecharBanco, migrarSupervisores } = require('../src/db');
  const auth = require('../src/auth');
  const { criarApp } = require('../src/app');
  const { montarPlanilha, analisar, criarAgrupador } = require('../src/planilha');

  const apagarTudo = () => consulta(`DROP TABLE IF EXISTS visita_supervisor, backup_promotores_supervisores, visitas, faturamento, faturamento_erp, clientes_erp, backup_faturamento_por_loja, importacoes_backup, supervisores, vinculos_promotor,
    importacoes, promotores, lojas, usuarios CASCADE`);

  // Migração: um banco no formato antigo (faturamento por loja, CNPJ único na loja) tem que virar o novo
  // sem perder nada. É o que acontece no banco do Render quando esta versão é publicada.
  await apagarTudo();
  await consulta(`
    CREATE TABLE lojas (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, cnpj TEXT UNIQUE, cidade TEXT NOT NULL DEFAULT '',
      uf TEXT NOT NULL DEFAULT '', endereco TEXT NOT NULL DEFAULT '', criado_em TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE promotores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT NOT NULL CHECK (tipo IN ('CLT', 'MEI', 'AGENCIA')),
      agencia TEXT NOT NULL DEFAULT '', telefone TEXT NOT NULL DEFAULT '', salario NUMERIC(12,2) NOT NULL DEFAULT 0,
      periculosidade NUMERIC(12,2) NOT NULL DEFAULT 0, ajuda_custo NUMERIC(12,2) NOT NULL DEFAULT 0, almoco NUMERIC(12,2) NOT NULL DEFAULT 0,
      vale_transporte NUMERIC(12,2) NOT NULL DEFAULT 0, outros_custos NUMERIC(12,2) NOT NULL DEFAULT 0, observacao TEXT NOT NULL DEFAULT '',
      ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX promotores_nome_unico ON promotores (lower(nome));
    CREATE TABLE importacoes (id SERIAL PRIMARY KEY, tipo TEXT NOT NULL);
    CREATE TABLE faturamento (id SERIAL PRIMARY KEY, loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE, mes TEXT NOT NULL,
      empresa TEXT NOT NULL DEFAULT '', valor NUMERIC(14,2) NOT NULL, importacao_id INTEGER REFERENCES importacoes(id), UNIQUE (loja_id, mes, empresa));
    CREATE TABLE visitas (id SERIAL PRIMARY KEY, promotor_id INTEGER NOT NULL REFERENCES promotores(id) ON DELETE CASCADE,
      loja_id INTEGER NOT NULL REFERENCES lojas(id) ON DELETE CASCADE, mes TEXT NOT NULL, qtd_visitas INTEGER NOT NULL DEFAULT 0,
      custo NUMERIC(12,2), importacao_id INTEGER REFERENCES importacoes(id), UNIQUE (promotor_id, loja_id, mes));
    INSERT INTO lojas (nome, cnpj, cidade, uf) VALUES ('Loja Atendida', '11222333000181', 'Joinville', 'SC'),
      ('Só do ERP', '22222333000106', 'Curitiba', 'PR'), ('Sem CNPJ', NULL, 'Lapa', 'PR');
    INSERT INTO promotores (nome, tipo, agencia, salario) VALUES ('Ana', 'AGENCIA', 'X', 0), ('Beto Souza - Sup ll', 'CLT', '', 3000),
      ('101 do Brasil - Filial PR (CLT)', 'CLT', '101 do Brasil - Filial PR (CLT)', 0);
    INSERT INTO importacoes (tipo) VALUES ('faturamento');
    INSERT INTO faturamento (loja_id, mes, empresa, valor, importacao_id) VALUES (1, '2026-10', '60', 1000, 1), (1, '2026-10', '63', 500, 1),
      (2, '2026-10', '60', 700, 1), (3, '2026-10', '', 50, 1);
    INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, custo) VALUES (1, 1, '2026-10', 4, 30), (1, 3, '2026-10', 4, 20);
  `);
  await iniciarBanco();
  await iniciarBanco(); // rodar de novo não pode repetir nem quebrar a migração
  assert.deepEqual(await consulta('SELECT cnpj, mes, empresa, valor FROM faturamento_erp ORDER BY cnpj, empresa'), [
    { cnpj: '11222333000181', mes: '2026-10', empresa: '60', valor: 1000 },
    { cnpj: '11222333000181', mes: '2026-10', empresa: '63', valor: 500 },
    { cnpj: '22222333000106', mes: '2026-10', empresa: '60', valor: 700 },
  ]);
  assert.deepEqual((await consulta('SELECT cnpj, nome FROM clientes_erp ORDER BY cnpj')).map((c) => c.nome), ['Loja Atendida', 'Só do ERP']);
  assert.deepEqual((await consulta('SELECT nome, chave FROM lojas ORDER BY id')), [
    { nome: 'Loja Atendida', chave: '11222333000181|loja atendida|joinville' },
    { nome: 'Sem CNPJ', chave: '|sem cnpj|lapa' }, // a loja "Só do ERP" virou cliente do ERP (não tinha atendimento)
  ]);
  assert.equal((await consulta('SELECT count(*)::int AS n FROM visitas'))[0].n, 2);
  // Cargo separado do nome; nome de agência com " - " fica inteiro; quem tem salário vira "cadastrado".
  // O supervisor ("Beto Souza - Sup ll") saiu dos promotores e foi para supervisores, com cópia do registro.
  assert.deepEqual(await consulta('SELECT nome, cargo, cadastrado FROM promotores ORDER BY id'), [
    { nome: 'Ana', cargo: '', cadastrado: false },
    { nome: '101 do Brasil - Filial PR (CLT)', cargo: '', cadastrado: false },
  ]);
  assert.deepEqual(await consulta('SELECT nome, cargo FROM supervisores'), [{ nome: 'Beto Souza', cargo: 'Sup ll' }]);
  assert.equal(Number((await consulta("SELECT dados->>'salario' AS s FROM backup_promotores_supervisores"))[0].s), 3000);
  assert.equal((await consulta('SELECT count(*)::int AS n FROM backup_faturamento_por_loja'))[0].n, 4); // cópia de segurança
  assert.equal((await consulta("SELECT to_regclass('public.faturamento') AS t"))[0].t, null);

  await apagarTudo();
  await iniciarBanco();
  await auth.criarUsuario({ login: 'suporte', nome: 'Suporte', senha: 'senha-suporte', perfil: 'suporte' });
  await auth.criarUsuario({ login: 'regis', nome: 'Regis', senha: 'senha-regis', perfil: 'usuario' });

  const servidor = criarApp().listen(0);
  const base = `http://localhost:${servidor.address().port}`;
  t.after(async () => { servidor.close(); await fecharBanco(); });

  // Pequeno "navegador": guarda o cookie do login e manda nas chamadas seguintes.
  const sessao = () => {
    let cookie = '';
    const chamar = async (caminho, opcoes = {}) => {
      const headers = { ...(opcoes.headers || {}), cookie };
      if (opcoes.json) { headers['content-type'] = 'application/json'; opcoes.body = JSON.stringify(opcoes.json); }
      const r = await fetch(base + caminho, { ...opcoes, headers });
      const novos = r.headers.getSetCookie();
      if (novos.length) cookie = novos.map((c) => c.split(';')[0]).join('; ');
      return { status: r.status, dados: await r.json().catch(() => null) };
    };
    chamar.cookie = () => cookie;
    return chamar;
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

  await t.test('velocidade: tela com versão no CSS/JS, arquivo com versão guardado no navegador e respostas comprimidas', async () => {
    const tela = await fetch(`${base}/resumo`, { headers: { cookie: suporte.cookie() } });
    const html = await tela.text();
    assert.equal(tela.headers.get('cache-control'), 'no-store');
    const versionado = html.match(/src="(\/js\/comum\.js\?v=[0-9a-f]{8})"/);
    assert.ok(versionado, 'a tela deve pedir o comum.js com ?v=');
    assert.match(html, /href="\/css\/estilo\.css\?v=[0-9a-f]{8}"/);
    const js = await fetch(base + versionado[1], { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control'), /max-age=31536000.*immutable/);
    assert.equal(js.headers.get('content-encoding'), 'gzip');
    const semVersao = await fetch(`${base}/js/comum.js`);
    assert.doesNotMatch(semVersao.headers.get('cache-control') || '', /immutable/); // sem versão, não guarda por muito tempo
    assert.equal((await fetch(`${base}/resumo`, { redirect: 'manual' })).status, 302); // tela continua exigindo login
    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /\/js\/login\.js\?v=[0-9a-f]{8}/);
  });

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
    assert.equal(r3.clientesNovos, 2); // dois CNPJs novos no ERP; o faturamento liga com as lojas pelo CNPJ
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
    const ficha = (await regis(`/api/lojas/${fora[0].id}?de=2026-09&ate=2026-10`)).dados;
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
    const [{ total }] = await consulta("SELECT count(*)::int AS total FROM clientes_erp WHERE cnpj = '33333444000106'");
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
    assert.equal(m.situacao, 'sem_cnpj'); // lojas sem CNPJ não ligam com o faturamento do Focco: faturamento zero
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

  await t.test('CNPJ em duas lojas: o faturamento é dividido; Lojas por UF, Agências e exportações batem', async () => {
    const gravar = (tipo, itens) => regis('/api/importar/gravar', { method: 'POST', json: { tipo, arquivo: 'rede.xlsx', itens } });
    const rede = (nome) => ({ nome, cnpj: '55555666000106', cidade: 'Curitiba', uf: 'Paraná' });
    const p = { nome: 'Promotora Rede', tipo: 'MEI', agencia: 'MEI Rede' };
    const r = (await gravar('visitas', [
      { promotor: p, loja: rede('Rede Centro'), mes: '2026-08', visitas: 4, custo: 100 },
      { promotor: p, loja: rede('Rede Bairro'), mes: '2026-08', visitas: 4, custo: 100 },
    ])).dados;
    assert.equal(r.lojasNovas, 2); // mesmo CNPJ, nomes diferentes: duas lojas
    await gravar('faturamento', [{ loja: { cnpj: '55555666000106', nome: 'REDE MATRIZ', cidade: 'Curitiba', uf: 'PR' }, mes: '2026-08', empresa: '60', valor: 20000 }]);
    const periodo = 'de=2026-08&ate=2026-08';
    const fat = (await regis(`/api/faturamento?${periodo}`)).dados;
    assert.deepEqual(fat.lojas.map((l) => [l.nome, l.faturamento, l.lojasDoCnpj]).sort(), [['Rede Bairro', 10000, 2], ['Rede Centro', 10000, 2]]);
    assert.equal(fat.totais.faturamento, 20000);
    assert.ok(fat.avisos.some((a) => a.id === 'cnpj_dividido'));

    const uf = (await regis(`/api/lojas-uf?${periodo}&uf=PR`)).dados;
    assert.deepEqual(uf.ufs, [{ uf: 'PR', lojas: 2 }]); // "Paraná" virou PR
    assert.deepEqual(uf.linhas.map((l) => [l.loja, l.valores['2026-08'], l.total, l.custo, l.faturamento, l.situacao]).sort(),
      [['Rede Bairro', 100, 100, 100, 10000, 'dentro'], ['Rede Centro', 100, 100, 100, 10000, 'dentro']]);
    const ag = (await regis(`/api/agencias?${periodo}`)).dados;
    assert.deepEqual([ag.faturamento, ag.custo, ag.percentual, ag.situacao], [20000, 200, 1, 'vale']);
    assert.deepEqual(ag.agencias.map((a) => [a.nome, a.qtdPromotores, a.qtdLojas, a.promotores[0].lojas.length]), [['MEI Rede', 1, 2, 2]]);

    const loja = fat.lojas.find((l) => l.nome === 'Rede Centro');
    const ficha = (await regis(`/api/lojas/${loja.id}?${periodo}`)).dados;
    assert.deepEqual(ficha.porMes.map((m) => [m.faturamentoCnpj, m.lojasDoCnpj, m.faturamento]), [[20000, 2, 10000]]);
    assert.deepEqual(ficha.outrasLojasDoCnpj.map((o) => o.nome), ['Rede Bairro']);
    const cliente = (await regis(`/api/clientes/55555666000106?${periodo}`)).dados;
    assert.deepEqual([cliente.faturamento, cliente.lojas.length], [20000, 2]);
    assert.equal((await regis(`/api/clientes/123?${periodo}`)).status, 400);
    assert.equal((await regis(`/api/clientes/99999999000199?${periodo}`)).status, 404);

    for (const caminho of ['/api/faturamento/exportar', '/api/promotores-exportar', '/api/lojas-uf/exportar', '/api/agencias/exportar']) {
      const resposta = await fetch(`${base}${caminho}?${periodo}`, { headers: { cookie: regis.cookie() } });
      assert.equal(resposta.status, 200, caminho);
      assert.match(resposta.headers.get('content-type'), /spreadsheetml/, caminho);
    }
  });

  await t.test('faturamento: importar complementa (nada é apagado); mesmo mês + CNPJ + empresa substitui; desfazer volta', async () => {
    const C1 = '11222333000181'; const C2 = '22222333000106'; const C3 = '33333444000106';
    const fat = (linhas, arquivo) => ({
      tipo: 'faturamento', arquivo,
      itens: linhas.map(([cnpj, valor, empresa = '60']) => ({ loja: { cnpj, nome: `C ${cnpj}`, cidade: 'X', uf: 'SC' }, mes: '2026-05', empresa, valor })),
    });
    const gravar = (d) => regis('/api/importar/gravar', { method: 'POST', json: d });
    const previa = (d) => regis('/api/importar/previa', { method: 'POST', json: d });
    const totalMaio = async () => (await regis('/api/faturamento?de=2026-05&ate=2026-05')).dados.totais.faturamento;
    const resumoPrevia = (p) => p.linhas.map((l) => [l.mes, l.empresa, l.novos, l.iguais, l.diferentes]);

    await gravar(fat([[C3, 500, '63']], 'empresa63.xls')); // outra empresa no mesmo mês
    const v1 = fat([[C1, 1000], [C2, 2000]], 'maio-v1.xls');
    const p1 = (await previa(v1)).dados;
    assert.deepEqual(resumoPrevia(p1), [['2026-05', '60', 2, 0, 0]]);
    assert.equal(p1.permiteSomar, false); // faturamento: sempre substitui o repetido
    await gravar(v1);
    assert.equal(await totalMaio(), 3500);

    const v2 = fat([[C1, 1500], [C2, 2000]], 'maio-v2.xls'); // C1 corrigido; C2 igual
    const p2 = (await previa(v2)).dados;
    assert.deepEqual(resumoPrevia(p2), [['2026-05', '60', 0, 1, 1]]);
    assert.match(p2.mensagem, /Nada será apagado/);
    assert.match(p2.mensagem, /no sistema R\$\s1\.000,00 → no arquivo R\$\s1\.500,00/);
    assert.equal(await totalMaio(), 3500); // a prévia não grava nada
    const r2 = (await gravar(v2)).dados;
    assert.deepEqual([r2.novos, r2.iguais, r2.substituidas], [0, 1, 1]);
    assert.equal(await totalMaio(), 4000); // 1.500 + 2.000 + 500

    const v3 = fat([[C1, 700]], 'maio-v3.xls'); // só o C1: o C2 e a empresa 63 continuam
    await gravar(v3);
    assert.equal(await totalMaio(), 3200); // 700 + 2.000 + 500

    // Desfazer: bloqueia só quem teve linhas alteradas por uma importação mais nova.
    const lista = async () => Object.fromEntries((await regis('/api/importacoes')).dados.map((i) => [i.arquivo, i]));
    let imps = await lista();
    assert.deepEqual(['empresa63.xls', 'maio-v1.xls', 'maio-v2.xls', 'maio-v3.xls'].map((a) => imps[a].podeDesfazer), [true, false, false, true]);
    assert.equal((await regis(`/api/importacoes/${imps['maio-v2.xls'].id}`, { method: 'DELETE' })).status, 400);
    let d = (await regis(`/api/importacoes/${imps['maio-v3.xls'].id}`, { method: 'DELETE' })).dados;
    assert.deepEqual([d.registros, d.restaurados], [1, 1]);
    assert.equal(await totalMaio(), 4000); // o C1 voltou para 1.500
    d = (await regis(`/api/importacoes/${(await lista())['maio-v2.xls'].id}`, { method: 'DELETE' })).dados;
    assert.deepEqual([d.registros, d.restaurados], [2, 2]);
    assert.equal(await totalMaio(), 3500); // voltou o que o v1 tinha gravado
    imps = await lista();
    assert.equal(imps['maio-v1.xls'].podeDesfazer, true);
    d = (await regis(`/api/importacoes/${imps['maio-v1.xls'].id}`, { method: 'DELETE' })).dados;
    assert.deepEqual([d.registros, d.restaurados], [2, 0]);
    assert.equal(await totalMaio(), 500);
  });

  await t.test('atendimentos: importar complementa; repetido diferente substitui ou soma; desfazer volta', async () => {
    const vis = (agencia, lojas, arquivo, visitas = 1, custo = 10) => ({
      tipo: 'visitas', arquivo,
      itens: lojas.map((nome) => ({ promotor: { nome: `P ${agencia}`, tipo: 'AGENCIA', agencia }, loja: { nome, cnpj: '', cidade: 'Y' }, mes: '2026-06', visitas, custo })),
    });
    const gravar = (d) => regis('/api/importar/gravar', { method: 'POST', json: d });
    const lojasDeJunho = async () => (await regis('/api/lojas-uf?de=2026-06&ate=2026-06')).dados.linhas.map((l) => l.loja).sort();
    const l1 = async () => {
      const [v] = await consulta("SELECT v.qtd_visitas, v.custo::float AS custo FROM visitas v JOIN lojas l ON l.id = v.loja_id WHERE l.nome = 'L1' AND v.mes = '2026-06'");
      return [v.qtd_visitas, v.custo];
    };
    await gravar(vis('Ag A', ['L1', 'L2'], 'a1.xlsx'));
    await gravar(vis('Ag B', ['L3'], 'b1.xlsx'));

    // A2: L1 com valores diferentes e L4 nova; a L2 não veio no arquivo e CONTINUA.
    const a2 = vis('Ag A', ['L1', 'L4'], 'a2.xlsx', 2, 25);
    const previa = (await regis('/api/importar/previa', { method: 'POST', json: a2 })).dados;
    assert.deepEqual(previa.linhas.map((l) => [l.mes, l.novos, l.iguais, l.diferentes]), [['2026-06', 1, 0, 1]]);
    assert.equal(previa.permiteSomar, true);
    assert.match(previa.mensagem, /P Ag A – L1 \(jun\/2026\): no sistema 1 visita \/ R\$\s10,00 → no arquivo 2 visitas \/ R\$\s25,00/);
    const r2 = (await gravar({ ...a2, modo: 'substituir' })).dados;
    assert.deepEqual([r2.novos, r2.iguais, r2.substituidas, r2.somadas], [1, 0, 1, 0]);
    assert.deepEqual(await lojasDeJunho(), ['L1', 'L2', 'L3', 'L4']);
    assert.deepEqual(await l1(), [2, 25]);

    // A3 com "somar": 2 + 3 visitas e R$ 25 + R$ 5.
    const r3 = (await gravar({ ...vis('Ag A', ['L1'], 'a3.xlsx', 3, 5), modo: 'somar' })).dados;
    assert.deepEqual([r3.novos, r3.substituidas, r3.somadas], [0, 0, 1]);
    assert.deepEqual(await l1(), [5, 30]);
    // O mesmo arquivo de novo, igual ao que está no sistema: "iguais", não muda nada.
    const r4 = (await gravar({ ...vis('Ag A', ['L1'], 'a4.xlsx', 5, 30), modo: 'somar' })).dados;
    assert.deepEqual([r4.novos, r4.iguais, r4.somadas], [0, 1, 0]);
    assert.deepEqual(await l1(), [5, 30]);

    // Desfazer da mais nova para a mais antiga; a agência B é independente e pode ser desfeita a qualquer hora.
    const lista = async () => Object.fromEntries((await regis('/api/importacoes')).dados.map((i) => [i.arquivo, i]));
    let imps = await lista();
    assert.deepEqual(['a1.xlsx', 'b1.xlsx', 'a2.xlsx', 'a3.xlsx', 'a4.xlsx'].map((a) => imps[a].podeDesfazer), [false, true, false, false, true]);
    for (const arquivo of ['a4.xlsx', 'a3.xlsx']) {
      imps = await lista();
      assert.equal((await regis(`/api/importacoes/${imps[arquivo].id}`, { method: 'DELETE' })).status, 200);
    }
    assert.deepEqual(await l1(), [2, 25]);
    imps = await lista();
    const d = (await regis(`/api/importacoes/${imps['a2.xlsx'].id}`, { method: 'DELETE' })).dados;
    assert.deepEqual([d.registros, d.restaurados], [2, 1]); // apagou L1 e L4; L1 voltou como era
    assert.deepEqual(await l1(), [1, 10]);
    assert.deepEqual(await lojasDeJunho(), ['L1', 'L2', 'L3']);

    // O cadastro de promotores não pode ser desfeito.
    await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'promotores', arquivo: 'cad.xlsx', itens: [{ nome: 'Zé Cadastro', codigo: '501', tipo: 'CLT' }] } });
    const cad = (await regis('/api/importacoes')).dados.find((i) => i.arquivo === 'cad.xlsx');
    assert.equal(cad.podeDesfazer, false);
    assert.equal((await regis(`/api/importacoes/${cad.id}`, { method: 'DELETE' })).status, 400);
  });

  await t.test('CLT: código "6" acha "06"; cargo separado do nome; supervisor fora do custo; aviso de código sem cadastro', async () => {
    const gravar = (d) => regis('/api/importar/gravar', { method: 'POST', json: d });
    const zero = { periculosidade: 0, ajuda_celular: 0, ajuda_custo: 0, almoco: 0, vale_transporte: 0, gratificacao: 0, outros_custos: 0 };
    await gravar({ tipo: 'promotores', arquivo: 'cadastro-sc.xlsx', itens: [
      { nome: 'Joana Lima - Sup ll', codigo: '07', tipo: 'CLT', empresa: 'Filial SC', salario: 5000, ...zero },
      { nome: 'Paulo Alves', codigo: '06', tipo: 'CLT', empresa: 'Filial SC', salario: 2000, ...zero },
    ] });
    const loja = { nome: 'Loja Abril', cnpj: '', cidade: 'Z' };
    const r = (await gravar({ tipo: 'visitas', arquivo: 'abril.xlsx', itens: [
      { promotor: { nome: 'PAULO', tipo: 'CLT', agencia: 'Filial SC (CLT)', codigo: '6' }, loja, mes: '2026-04', visitas: 4, custo: null },
      { promotor: { nome: 'ZECA', tipo: 'CLT', agencia: 'Filial SC (CLT)', codigo: '99' }, loja, mes: '2026-04', visitas: 4, custo: null },
    ] })).dados;
    assert.equal(r.avisos['Promotor com código que não está no cadastro (sem salário para calcular o custo)'], 1);

    const lista = (await regis('/api/promotores?de=2026-04&ate=2026-04')).dados.promotores;
    const paulo = lista.find((p) => p.nome === 'Paulo Alves');
    assert.deepEqual([paulo.qtdLojas, paulo.custo, paulo.agencia], [1, 2000, 'Filial SC (CLT)']); // achou pelo código e ganhou a agência
    // Supervisor não é promotor: foi para o cadastro de supervisores (só nome, código, cargo e empresa).
    assert.equal(lista.find((p) => p.nome.startsWith('Joana')), undefined);
    const sups = (await regis('/api/supervisores?de=2026-04&ate=2026-04')).dados.supervisores;
    assert.ok(sups.some((x) => x.nome === 'Joana Lima' && x.codigo === '07' && x.cargo === 'Sup ll'));

    const avisos = (await regis('/api/resumo?de=2026-04&ate=2026-04')).dados.avisos;
    const semCadastro = avisos.find((a) => a.id === 'codigo_sem_cadastro');
    assert.deepEqual(semCadastro.itens, ['Filial SC (CLT) — ZECA (código 99): 1 loja(s)']);
    const semLoja = avisos.find((a) => a.id === 'sem_lojas');
    assert.ok(!semLoja.itens.some((i) => i.startsWith('Joana')), 'supervisor não entra em "Promotores sem loja lançada"');
  });

  await t.test('supervisores: "Jesus, Leo" vira 2 vínculos; acento; promotor sem supervisor; filtro, tela, juntar e desfazer', async () => {
    const gravar = (d) => regis('/api/importar/gravar', { method: 'POST', json: d });
    assert.equal((await regis('/api/supervisores', { method: 'POST', json: { nome: 'Jesus Angels Zapata Rivas', codigo: '19' } })).status, 200);
    assert.equal((await regis('/api/supervisores', { method: 'POST', json: { nome: 'JESUS ANGELS ZAPATA RIVAS' } })).status, 400); // repetido
    const linha = (promotor, loja, supervisor) => ({
      promotor: { nome: promotor, tipo: 'AGENCIA', agencia: 'Ag Sup' }, loja: { nome: loja, cnpj: '', cidade: 'W' }, mes: '2026-03', visitas: 1, custo: 50, supervisor,
    });
    const arquivo = { tipo: 'visitas', arquivo: 'sup.xlsx', itens: [linha('Carla', 'Loja S1', 'Jesus, Leo'), linha('Carla', 'Loja S2', 'jesús'), linha('Dora', 'Loja S3', '')] };
    const r = (await gravar(arquivo)).dados;
    assert.equal(r.vinculosSupervisor, 3); // S1: Jesus e Leo; S2: Jesus; S3: nenhum
    assert.deepEqual(r.supervisoresPorPrimeiroNome, ['Jesus → Jesus Angels Zapata Rivas']);
    assert.deepEqual(r.supervisoresCriados, ['Leo']);
    // Nenhum promotor foi criado a partir do nome de um supervisor.
    assert.equal((await consulta("SELECT count(*)::int AS n FROM promotores WHERE nome IN ('Jesus', 'Leo')"))[0].n, 0);

    const ids = Object.fromEntries((await consulta('SELECT id, nome FROM supervisores')).map((x) => [x.nome, x.id]));
    const lojas = async (filtro) => (await regis(`/api/lojas-uf?de=2026-03&ate=2026-03${filtro}`)).dados.linhas.map((x) => x.loja).sort();
    assert.deepEqual(await lojas(`&supervisor=${ids['Jesus Angels Zapata Rivas']}`), ['Loja S1', 'Loja S2']);
    assert.deepEqual(await lojas(`&supervisor=${ids.Leo}`), ['Loja S1']); // "Jesus, Leo" aparece no filtro dos dois
    assert.deepEqual(await lojas('&supervisor=Jesus'), ['Loja S1', 'Loja S2', 'Loja S3']); // texto antigo no filtro é ignorado
    const s1 = (await regis('/api/lojas-uf?de=2026-03&ate=2026-03')).dados.linhas.find((x) => x.loja === 'Loja S1');
    assert.equal(s1.supervisor, 'Jesus Angels Zapata Rivas, Leo');

    const tela = (await regis('/api/supervisores?de=2026-03&ate=2026-03')).dados;
    const jesus = tela.supervisores.find((x) => x.nome === 'Jesus Angels Zapata Rivas');
    assert.deepEqual([jesus.promotores.map((x) => [x.nome, x.lojas]), jesus.agencias, jesus.lojas], [[['Carla', 2]], ['Ag Sup'], 2]);
    assert.deepEqual(tela.semSupervisor.map((x) => x.nome), ['Dora']); // promotor sem supervisor
    // Supervisor nunca aparece como promotor (lista, seletor, "Ligar a").
    const nomesPromotores = (await regis('/api/promotores?de=2026-03&ate=2026-03')).dados.promotores.map((x) => x.nome);
    assert.ok(!nomesPromotores.some((n) => /jesus|leo/i.test(n)));
    assert.equal((await regis('/api/promotores', { method: 'POST', json: { nome: 'Fulano', tipo: 'CLT', cargo: 'Supervisor' } })).status, 400);

    // Reimportar a Loja S1 com outro supervisor (substitui só ela; a S2 continua) e desfazer: os vínculos voltam.
    await gravar({ ...arquivo, arquivo: 'sup-v2.xlsx', itens: [linha('Carla', 'Loja S1', 'Leo')] });
    assert.deepEqual(await lojas(`&supervisor=${ids['Jesus Angels Zapata Rivas']}`), ['Loja S2']);
    const imp = (await regis('/api/importacoes')).dados.find((i) => i.arquivo === 'sup-v2.xlsx');
    assert.equal((await regis(`/api/importacoes/${imp.id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await lojas(`&supervisor=${ids['Jesus Angels Zapata Rivas']}`), ['Loja S1', 'Loja S2']);

    // Juntar: "Leo" é a mesma pessoa que o Jesus (só para o teste). Os vínculos passam, sem duplicar.
    assert.equal((await regis(`/api/supervisores/${ids.Leo}`, { method: 'PUT', json: { nome: 'jesus angels zapata rivas' } })).status, 400);
    const j = (await regis(`/api/supervisores/${ids.Leo}/juntar`, { method: 'POST', json: { destinoId: ids['Jesus Angels Zapata Rivas'] } })).dados;
    assert.equal(j.supervisor, 'Jesus Angels Zapata Rivas');
    assert.equal((await consulta('SELECT count(*)::int AS n FROM supervisores WHERE id = $1', [ids.Leo]))[0].n, 0);
    assert.deepEqual(await lojas(`&supervisor=${ids['Jesus Angels Zapata Rivas']}`), ['Loja S1', 'Loja S2']);
  });

  await t.test('migração de supervisores: cargo ou nome completo (nunca o primeiro nome); com atendimento fica no aviso; rodar de novo não duplica', async () => {
    await consulta("INSERT INTO supervisores (nome, chave) VALUES ('Marta Reis', 'marta reis')");
    await consulta(`INSERT INTO promotores (nome, tipo, agencia, cargo, salario) VALUES
      ('MARTA REIS', 'AGENCIA', 'Ag M', '', 0), ('Marta', 'AGENCIA', 'Ag M', '', 0),
      ('Rita Gomes', 'CLT', '', 'Sup. l', 4000), ('Paulo Sup', 'CLT', 'Ag M', 'Supervisor', 3000)`);
    const [paulo] = await consulta("SELECT id FROM promotores WHERE nome = 'Paulo Sup'");
    const [loja] = await consulta("SELECT id FROM lojas WHERE nome = 'Loja S3'");
    // Atendimento antigo com o supervisor só como texto (sem vínculo): a migração cria os vínculos.
    const [v] = await consulta("INSERT INTO visitas (promotor_id, loja_id, mes, qtd_visitas, supervisor) VALUES ($1, $2, '2026-03', 1, 'Marta Reis / Rita Gomes') RETURNING id", [paulo.id, loja.id]);
    const r1 = await migrarSupervisores();
    assert.deepEqual(r1.movidos.sort(), ['MARTA REIS (nome igual ao de um supervisor)', 'Rita Gomes (Sup. l)']);
    assert.deepEqual(r1.noAviso, ['Paulo Sup (Supervisor, 1 atendimento(s))']);
    assert.equal((await consulta("SELECT count(*)::int AS n FROM promotores WHERE nome = 'Marta'"))[0].n, 1); // homônimo pelo primeiro nome fica
    const vinculos = await consulta('SELECT s.nome FROM visita_supervisor vs JOIN supervisores s ON s.id = vs.supervisor_id WHERE vs.visita_id = $1 ORDER BY 1', [v.id]);
    assert.deepEqual(vinculos.map((x) => x.nome), ['MARTA REIS', 'Rita Gomes']);
    assert.equal((await consulta("SELECT dados->>'salario' AS s FROM backup_promotores_supervisores WHERE dados->>'nome' = 'Rita Gomes'"))[0].s, '4000');
    const contar = async () => (await consulta('SELECT (SELECT count(*) FROM supervisores) + (SELECT count(*) FROM visita_supervisor) + (SELECT count(*) FROM promotores) AS n'))[0].n;
    const antes = await contar();
    const r2 = await migrarSupervisores();
    assert.deepEqual([r2.movidos, r2.vinculos], [[], 0]);
    assert.equal(await contar(), antes);
    // O supervisor que ficou como promotor aparece no aviso das telas.
    const avisos = (await regis('/api/resumo?de=2026-03&ate=2026-03')).dados.avisos;
    assert.match(avisos.find((a) => a.id === 'supervisor_como_promotor').itens[0], /^Paulo Sup \(Supervisor\)/);
  });

  await t.test('promotor sem código: nome completo + agência; primeiro nome só se único; senão pendente e ligação à mão', async () => {
    for (const nome of ['Ana Paula', 'Ana Clara', 'Bruno Dias']) {
      await regis('/api/promotores', { method: 'POST', json: { nome, tipo: 'AGENCIA', agencia: 'Agência Q' } });
    }
    const ids = Object.fromEntries((await consulta("SELECT id, nome FROM promotores WHERE agencia = 'Agência Q'")).map((x) => [x.nome, x.id]));
    const arquivo = {
      tipo: 'visitas', arquivo: 'q.xlsx',
      itens: [['Bruno', 'Loja Q1'], ['Ana', 'Loja Q2'], ['Ana Paula', 'Loja Q3']].map(([nome, loja]) => ({
        promotor: { nome, tipo: 'AGENCIA', agencia: 'Agência Q' }, loja: { nome: loja, cnpj: '', cidade: 'Q' }, mes: '2026-02', visitas: 1, custo: 10,
      })),
    };
    const r = (await regis('/api/importar/gravar', { method: 'POST', json: arquivo })).dados;
    assert.equal(r.promotoresNovos, 1); // só o "Ana" (duas Anas na agência: não adivinha)
    assert.equal(r.avisos['Promotor não identificado (ligue à mão na tela Promotores)'], 1);
    const lojasDe = async (id) => (await consulta("SELECT l.nome FROM visitas v JOIN lojas l ON l.id = v.loja_id WHERE v.promotor_id = $1 AND v.mes = '2026-02' ORDER BY 1", [id])).map((x) => x.nome);
    assert.deepEqual(await lojasDe(ids['Bruno Dias']), ['Loja Q1']); // primeiro nome único na agência
    assert.deepEqual(await lojasDe(ids['Ana Paula']), ['Loja Q3']); // nome completo

    const { pendentes } = (await regis('/api/promotores/nao-identificados')).dados;
    const ana = pendentes.find((x) => x.nome === 'Ana');
    assert.deepEqual([ana.pendente, ana.lojas, ana.candidatos.sort()], ['ambiguo', 1, [ids['Ana Paula'], ids['Ana Clara']].sort()]);
    const avisos = (await regis('/api/resumo?de=2026-02&ate=2026-02')).dados.avisos;
    assert.match(avisos.find((a) => a.id === 'promotores_nao_identificados').itens[0], /Agência Q — Ana \(mais de um parecido no cadastro\)/);

    assert.equal((await regis(`/api/promotores/${ana.id}/ligar`, { method: 'POST', json: { destinoId: ana.id } })).status, 400);
    const ligado = (await regis(`/api/promotores/${ana.id}/ligar`, { method: 'POST', json: { destinoId: ids['Ana Clara'] } })).dados;
    assert.deepEqual([ligado.atendimentos, ligado.promotor], [1, 'Ana Clara']);
    assert.deepEqual(await lojasDe(ids['Ana Clara']), ['Loja Q2']);
    // Reimportar o mesmo arquivo: a ligação guardada resolve o "Ana" sozinho.
    const r2 = (await regis('/api/importar/gravar', { method: 'POST', json: arquivo })).dados;
    assert.equal(r2.promotoresNovos, 0);
    assert.equal(r2.avisos['Promotor não identificado (ligue à mão na tela Promotores)'], undefined);
    assert.deepEqual(await lojasDe(ids['Ana Clara']), ['Loja Q2']);
    assert.equal((await regis('/api/promotores/nao-identificados')).dados.pendentes.filter((x) => x.agencia === 'Agência Q').length, 0);
  });

  await t.test('MEIs sem agência: o arquivo de um não apaga nada (nem o do outro, nem o dele)', async () => {
    const mei = (nome, loja) => ({ tipo: 'visitas', arquivo: `${nome}.xlsx`, itens: [{ promotor: { nome, tipo: 'MEI', agencia: '' }, loja: { nome: loja, cnpj: '', cidade: 'M' }, mes: '2026-01', visitas: 1, custo: 20 }] });
    const gravar = (d) => regis('/api/importar/gravar', { method: 'POST', json: d });
    const lojasDeJaneiro = async () => (await regis('/api/lojas-uf?de=2026-01&ate=2026-01')).dados.linhas.map((l) => l.loja).sort();
    await gravar(mei('Mei Um', 'Loja X'));
    await gravar(mei('Mei Dois', 'Loja Y'));
    const previa = (await regis('/api/importar/previa', { method: 'POST', json: mei('Mei Um', 'Loja Z') })).dados;
    assert.deepEqual(previa.linhas.map((l) => [l.novos, l.iguais, l.diferentes]), [[1, 0, 0]]); // Loja Z é nova
    await gravar(mei('Mei Um', 'Loja Z'));
    assert.deepEqual(await lojasDeJaneiro(), ['Loja X', 'Loja Y', 'Loja Z']); // complementa: a Loja X continua
  });

  await t.test('importação antiga sem cópia: só apaga se digitar APAGAR', async () => {
    await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'faturamento', arquivo: 'antiga.xls', itens: [{ loja: { cnpj: '55555666000106', nome: 'Antiga', cidade: 'A' }, mes: '2025-12', empresa: '', valor: 10 }] } });
    const [imp] = await consulta("UPDATE importacoes SET restauravel = FALSE WHERE arquivo = 'antiga.xls' RETURNING id");
    const item = (await regis('/api/importacoes')).dados.find((i) => i.id === imp.id);
    assert.deepEqual([item.restauravel, item.podeDesfazer], [false, true]);
    const sem = await regis(`/api/importacoes/${imp.id}`, { method: 'DELETE' });
    assert.equal(sem.status, 400);
    assert.match(sem.dados.erro, /digite APAGAR/);
    assert.equal((await regis(`/api/importacoes/${imp.id}?confirmacao=apagar`, { method: 'DELETE' })).status, 400); // tem que ser exatamente APAGAR
    const ok = (await regis(`/api/importacoes/${imp.id}?confirmacao=APAGAR`, { method: 'DELETE' })).dados;
    assert.deepEqual([ok.registros, ok.restaurados, ok.semCopia], [1, 0, true]);
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
    const item = (valor) => ({ loja: { nome: 'Cliente Desfazer', cnpj: '44444555000106', cidade: 'X' }, mes: '2026-07', empresa: '', valor });
    await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'faturamento', arquivo: 'a', itens: [item(100)] } });
    const antes = (await regis('/api/importacoes')).dados[0];
    assert.equal(antes.total, 100);
    assert.equal((await regis('/api/faturamento?de=2026-07&ate=2026-07')).dados.totais.faturamento, 100);
    const r = await regis(`/api/importacoes/${antes.id}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.dados.registros], [200, 1]);
    assert.equal((await regis('/api/faturamento?de=2026-07&ate=2026-07')).dados.totais.faturamento, null); // nada no mês: "—"
    assert.equal((await regis(`/api/importacoes/${antes.id}`, { method: 'DELETE' })).status, 404);

    const pedro = (await regis('/api/promotores?de=2026-10&ate=2026-10&busca=PEDRO')).dados.promotores[0];
    assert.equal(pedro.qtdLojas, 1);
    assert.equal((await regis(`/api/promotores/${pedro.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await regis('/api/promotores?de=2026-10&ate=2026-10&busca=PEDRO')).dados.promotores.length, 0);
    assert.equal((await regis(`/api/promotores/${pedro.id}`, { method: 'DELETE' })).status, 404);
  });

  await t.test('pendentes: salvar pela tela limpa o pendente e liga duplicados; lista do Ligar; cadastro completa sem apagar', async () => {
    const gravar = (d) => regis('/api/importar/gravar', { method: 'POST', json: d });
    const clt = (nome, codigo, loja) => ({ promotor: { nome, tipo: 'CLT', agencia: 'Ag Pend', codigo }, loja: { nome: loja, cnpj: '', cidade: 'P' }, mes: '2026-08', visitas: 2, custo: null });
    // Atendimentos de CLTs que não estão no cadastro: viram pendentes "nao_encontrado".
    await gravar({ tipo: 'visitas', arquivo: 'pend.xlsx', itens: [clt('Zé Pendente da Silva', '06', 'Loja P1'), clt('Maria Sem Codigo', '', 'Loja P2'), clt('Ana Pendente Cadastro', '', 'Loja P3')] });
    const pend = async () => (await regis('/api/promotores/nao-identificados')).dados;
    const nomesPendentes = async () => (await pend()).pendentes.map((x) => x.nome).filter((n) => /Pendente|Sem Codigo/i.test(n)).sort();
    assert.deepEqual(await nomesPendentes(), ['Ana Pendente Cadastro', 'Maria Sem Codigo', 'Zé Pendente da Silva']);
    const visitasDe = async (id) => (await consulta('SELECT count(*)::int AS n FROM visitas WHERE promotor_id = $1', [id]))[0].n;

    // a) + b) Criar pela tela com código "6" (o pendente tem "06"), mesma agência, nome sem acento e em maiúsculas:
    // liga automaticamente, passa o atendimento e apaga o duplicado.
    const criado = (await regis('/api/promotores', { method: 'POST', json: { nome: 'ZE PENDENTE DA SILVA', tipo: 'CLT', codigo: '6', agencia: 'Ag Pend', salario: 2000 } })).dados;
    assert.deepEqual(criado.ligados.map((l) => [l.nome, l.atendimentos]), [['Zé Pendente da Silva', 1]]);
    assert.equal(await visitasDe(criado.id), 1);
    assert.deepEqual(await nomesPendentes(), ['Ana Pendente Cadastro', 'Maria Sem Codigo']);
    // Nome, agência e código IGUAIS aos do pendente: não é "duplicado", é a mesma pessoa (liga em vez de recusar).
    await gravar({ tipo: 'visitas', arquivo: 'pend2.xlsx', itens: [clt('Igual Igual', '9', 'Loja P4')] });
    const igual = await regis('/api/promotores', { method: 'POST', json: { nome: 'Igual Igual', tipo: 'CLT', codigo: '9', agencia: 'Ag Pend' } });
    assert.equal(igual.status, 200, JSON.stringify(igual.dados));
    assert.deepEqual(igual.dados.ligados.map((l) => l.nome), ['Igual Igual']);

    // a) Editar e salvar o próprio pendente pela tela: deixa de ser pendente e passa a poder receber ligações.
    const maria = (await pend()).pendentes.find((x) => x.nome === 'Maria Sem Codigo');
    const editado = (await regis(`/api/promotores/${maria.id}`, { method: 'PUT', json: { nome: 'Maria Sem Codigo', tipo: 'CLT', agencia: 'Ag Pend', salario: 1500 } })).dados;
    assert.deepEqual([editado.id, editado.ligados], [maria.id, []]);
    assert.deepEqual(await nomesPendentes(), ['Ana Pendente Cadastro']);
    const [linhaMaria] = await consulta('SELECT pendente, cadastrado FROM promotores WHERE id = $1', [maria.id]);
    assert.deepEqual([linhaMaria.pendente, linhaMaria.cadastrado], ['', true]);

    // c) A lista do "Ligar" traz os promotores cadastrados (antes vinha vazia quando todos eram pendentes).
    const { cadastro } = await pend();
    assert.ok(cadastro.some((c) => c.id === maria.id) && cadastro.some((c) => c.id === criado.id));
    assert.ok(!cadastro.some((c) => /Ana Pendente/.test(c.nome))); // pendente não é opção

    // d) Cadastro à mão com dados que a planilha não tem; a planilha traz código "0777" e só o salário novo:
    // atualiza o mesmo promotor (não duplica) e o que veio vazio NÃO apaga o que foi preenchido à mão.
    const manual = (await regis('/api/promotores', { method: 'POST', json: {
      nome: 'Teste Completar', tipo: 'CLT', codigo: '777', empresa: '101 PR', admissao: '2026-03-01', salario: 2000, periculosidade: 300, vale_transporte: 150 } })).dados;
    const vazio = { periculosidade: null, ajuda_celular: null, ajuda_custo: null, almoco: null, vale_transporte: null, gratificacao: null, outros_custos: null };
    const cad = { tipo: 'promotores', arquivo: 'cad-completa.xlsx', itens: [{ nome: 'TESTE COMPLETAR', codigo: '0777', tipo: 'CLT', salario: 2500, ...vazio },
      { nome: 'Ana Pendente Cadastro', codigo: '', tipo: 'CLT', empresa: 'Ag Pend', salario: 1800, ...vazio }] };
    const previa = (await regis('/api/importar/previa', { method: 'POST', json: cad })).dados;
    assert.deepEqual([previa.atualizar, previa.criar], [['TESTE COMPLETAR → Teste Completar', 'Ana Pendente Cadastro'], []]);
    const r = (await gravar(cad)).dados;
    assert.deepEqual([r.promotoresNovos, r.promotoresAtualizados], [0, 2]);
    const [depois] = await consulta(`SELECT count(*) OVER ()::int AS iguais, nome, codigo, empresa, admissao, salario::float, periculosidade::float,
      vale_transporte::float, cadastrado, pendente FROM promotores WHERE lower(nome) = 'teste completar'`);
    assert.deepEqual(depois, { iguais: 1, nome: 'TESTE COMPLETAR', codigo: '0777', empresa: '101 PR', admissao: '2026-03-01', salario: 2500,
      periculosidade: 300, vale_transporte: 150, cadastrado: true, pendente: '' });
    assert.equal(manual.ligados.length, 0);
    // O pendente "Ana" foi atualizado no lugar (mesmo nome): ficou cadastrado, com o atendimento, e saiu das pendências.
    assert.deepEqual(await nomesPendentes(), []);
    const [ana] = await consulta("SELECT id, salario::float, cadastrado, pendente FROM promotores WHERE nome = 'Ana Pendente Cadastro'");
    assert.deepEqual([ana.salario, ana.cadastrado, ana.pendente, await visitasDe(ana.id)], [1800, true, '', 1]);
  });

  await t.test('data de admissão: só AAAA-MM-DD que existe, ano de 1950 ao ano atual + 1 (tela e importação)', async () => {
    const anoQueVem = new Date().getFullYear() + 1;
    const salvar = (admissao) => regis('/api/promotores', { method: 'POST', json: { nome: `Data Teste ${admissao || 'vazia'}`, tipo: 'CLT', admissao } });
    for (const [data, trecho] of [['2026-02-31', 'essa data não existe'], ['9999-99-99', 'o ano precisa estar entre 1950'], ['1949-12-31', 'o ano precisa estar entre 1950'],
      [`${anoQueVem + 1}-01-01`, `entre 1950 e ${anoQueVem}`], ['2026-13-01', 'esse mês não existe'], ['01/02/2026', 'formato AAAA-MM-DD'], ['2025-02-29', 'essa data não existe']]) {
      const r = await salvar(data);
      assert.equal(r.status, 400, data);
      assert.match(r.dados.erro, new RegExp(trecho), data);
    }
    for (const data of ['', '2024-02-29', `${anoQueVem}-12-31`, '1950-01-01']) assert.equal((await salvar(data)).status, 200, data || 'vazio');
    // Editar (PUT) também valida.
    const [p] = await consulta("SELECT id FROM promotores WHERE nome = 'Data Teste vazia'");
    assert.equal((await regis(`/api/promotores/${p.id}`, { method: 'PUT', json: { nome: 'Data Teste vazia', tipo: 'CLT', admissao: '2026-04-31' } })).status, 400);
    // Importação do cadastro: data inválida recusa o arquivo inteiro, sem gravar nada.
    const antes = (await consulta('SELECT count(*)::int AS n FROM promotores'))[0].n;
    const r = await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'promotores', arquivo: 'datas.xlsx', itens: [
      { nome: 'Data Boa', tipo: 'CLT', admissao: '2026-01-10', salario: 1 }, { nome: 'Data Ruim', tipo: 'CLT', admissao: '2026-02-30', salario: 1 }] } });
    assert.equal(r.status, 400);
    assert.match(r.dados.erro, /Data de admissão inválida para "Data Ruim" \(essa data não existe\): 2026-02-30/);
    assert.equal((await consulta('SELECT count(*)::int AS n FROM promotores'))[0].n, antes);
  });

  await t.test('desfazer apaga os promotores que a importação criou e ficaram sem atendimento; limpar pendentes órfãos', async () => {
    const item = (nome, loja) => ({ promotor: { nome, tipo: 'CLT', agencia: 'Ag Orfa', codigo: '' }, loja: { nome: loja, cnpj: '', cidade: 'O' }, mes: '2026-09', visitas: 1, custo: 5 });
    await regis('/api/importar/gravar', { method: 'POST', json: { tipo: 'visitas', arquivo: 'orfa.xlsx', itens: [item('Orfa Um', 'Loja O1'), item('Orfa Dois', 'Loja O2')] } });
    const [criados] = await consulta("SELECT count(*)::int AS n, min(importacao_id) AS imp FROM promotores WHERE nome LIKE 'Orfa %'");
    assert.equal(criados.n, 2);
    // "Orfa Dois" foi cadastrado pela tela depois: não pode ser apagado pelo Desfazer.
    const [dois] = await consulta("SELECT id FROM promotores WHERE nome = 'Orfa Dois'");
    await regis(`/api/promotores/${dois.id}`, { method: 'PUT', json: { nome: 'Orfa Dois', tipo: 'CLT', agencia: 'Ag Orfa' } });
    const d = (await regis(`/api/importacoes/${criados.imp}`, { method: 'DELETE' })).dados;
    assert.deepEqual([d.registros, d.promotoresApagados], [2, 1]);
    assert.deepEqual((await consulta("SELECT nome FROM promotores WHERE nome LIKE 'Orfa %'")).map((x) => x.nome), ['Orfa Dois']);
    // Pendente órfão antigo (sem importação de origem e sem atendimento): a tela consegue limpar.
    await consulta("INSERT INTO promotores (nome, tipo, agencia, pendente) VALUES ('Orfa Antigo', 'CLT', 'Ag Orfa', 'nao_encontrado')");
    const limpo = (await regis('/api/promotores/nao-identificados/limpar', { method: 'POST' })).dados;
    assert.ok(limpo.apagados >= 1);
    assert.equal((await consulta("SELECT count(*)::int AS n FROM promotores WHERE nome = 'Orfa Antigo'"))[0].n, 0);
    assert.ok((await regis('/api/promotores/nao-identificados')).dados.pendentes.every((x) => x.lojas > 0)); // só ficam os com atendimento
  });

  await t.test('código sem zeros à esquerda: busca e checagem de duplicado ("06" = "6")', async () => {
    assert.equal((await regis('/api/promotores', { method: 'POST', json: { nome: 'Codigo Zero', tipo: 'CLT', agencia: 'Ag Cod', codigo: '6' } })).status, 200);
    const dup = await regis('/api/promotores', { method: 'POST', json: { nome: 'codigo zero', tipo: 'CLT', agencia: 'ag cod', codigo: '006' } });
    assert.deepEqual([dup.status, dup.dados.erro], [400, 'Já existe um promotor com esse nome, agência e código.']);
    const achados = (await regis('/api/promotores?de=2026-10&ate=2026-10&busca=06')).dados.promotores.map((x) => x.nome);
    assert.ok(achados.includes('Codigo Zero'));
  });

  await t.test('período aceito pela API: de 2020-01 até o mês atual + 12', async () => {
    const agora = new Date();
    const mes = (somar) => { const d = new Date(agora.getFullYear(), agora.getMonth() + somar, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    for (const [de, ate] of [['2019-12', '2026-01'], ['2020-01', mes(13)], ['2026-05', '2026-04']]) {
      const r = await regis(`/api/resumo?de=${de}&ate=${ate}`);
      assert.equal(r.status, 400, `${de} a ${ate}`);
    }
    assert.match((await regis('/api/resumo?de=2019-12&ate=2026-01')).dados.erro, /de jan\/2020 até/);
    assert.equal((await regis(`/api/resumo?de=2020-01&ate=${mes(12)}`)).status, 200);
    assert.equal((await regis('/api/lojas-uf/exportar?de=2019-01&ate=2019-02')).status, 400); // exportações também
  });

  await t.test('segurança: senha mínima no servidor, /api/usuarios só para o suporte (403), cookie e cabeçalhos', async () => {
    // Senha mínima de 8 caracteres validada no SERVIDOR: criar usuário, editar usuário e trocar a própria senha.
    const curta = await suporte('/api/usuarios', { method: 'POST', json: { login: 'curta', nome: 'Curta', senha: '1234567', perfil: 'usuario' } });
    assert.deepEqual([curta.status, curta.dados.erro], [400, 'A senha precisa ter pelo menos 8 caracteres.']);
    const reg = (await suporte('/api/usuarios')).dados.find((u) => u.login === 'regis');
    const editar = await suporte(`/api/usuarios/${reg.id}`, { method: 'PUT', json: { nome: 'Nome Que Nao Pode Gravar', senha: 'curta' } });
    assert.equal(editar.status, 400);
    assert.equal((await suporte('/api/usuarios')).dados.find((u) => u.login === 'regis').nome, reg.nome); // nada foi gravado
    assert.equal((await regis('/api/conta/senha', { method: 'POST', json: { senhaAtual: 'senha-regis', senhaNova: '1234567' } })).status, 400);

    // Usuário comum recebe 403 em TODAS as rotas de usuários (a checagem é no servidor, não só na tela).
    for (const [metodo, caminho, json] of [['GET', '/api/usuarios'], ['POST', '/api/usuarios', { login: 'x99', nome: 'X', senha: '12345678', perfil: 'suporte' }],
      ['PUT', `/api/usuarios/${reg.id}`, { perfil: 'suporte' }], ['DELETE', `/api/usuarios/${reg.id}`]]) {
      assert.equal((await regis(caminho, { method: metodo, ...(json ? { json } : {}) })).status, 403, `${metodo} ${caminho}`);
    }
    assert.equal((await suporte('/api/usuarios')).dados.find((u) => u.login === 'regis').perfil, 'usuario');

    // Cabeçalhos: API sem cache e HSTS.
    const r = await fetch(`${base}/api/eu`, { headers: { cookie: regis.cookie() } });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal((await fetch(`${base}/api/resumo`)).headers.get('cache-control'), 'no-store'); // até o 401

    // Cookie de sessão: HttpOnly e SameSite=Lax sempre; Secure em produção (atrás do HTTPS do Render).
    const entrar = (url, extra) => fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify({ login: 'regis', senha: 'senha-regis' }) });
    const cookieDev = (await entrar(base, { 'x-forwarded-for': '10.77.0.1' })).headers.getSetCookie().join('; ').toLowerCase();
    assert.match(cookieDev, /httponly/);
    assert.match(cookieDev, /samesite=lax/);
    const config = require('../src/config');
    const antes = config.producao;
    config.producao = true;
    const producao = criarApp().listen(0);
    config.producao = antes;
    try {
      const resposta = await entrar(`http://localhost:${producao.address().port}`, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.77.0.2' });
      const cookie = resposta.headers.getSetCookie().join('; ').toLowerCase();
      assert.equal(resposta.status, 200);
      assert.match(cookie, /httponly/);
      assert.match(cookie, /samesite=lax/);
      assert.match(cookie, /; secure/);
    } finally {
      producao.close();
    }
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
