// Ficha da loja. Abre ao clicar numa linha da tela Faturamento:
//  - /loja?id=15            loja atendida: a parte dela do faturamento do CNPJ, custo e promotores, mês a mês;
//  - /loja?cnpj=1234...     cliente do ERP que comprou sem atendimento: o faturamento do CNPJ, mês a mês.
let paginas = null;
const endereco = new URLSearchParams(location.search);

function empresasDoMes(empresas) {
  if (!empresas.length) return '—';
  if (empresas.length === 1) return esc(empresas[0].empresa || '—');
  return empresas.map((e) => `<span class="menor">${esc(e.empresa || 'sem empresa')}: ${reais(e.valor)}</span>`).join('');
}

async function carregarLoja(id) {
  const d = await api(`/api/lojas/${id}?${parametros(periodoAtual())}`);
  const l = d.loja;
  document.title = `${l.nome} · Controle de Promotores`;
  document.getElementById('nome').textContent = l.nome;
  const partes = [l.cnpj ? `CNPJ ${cnpjFormatado(l.cnpj)}` : 'Sem CNPJ válido', [l.cidade, l.uf].filter(Boolean).join(' · '), l.endereco].filter(Boolean);
  document.getElementById('sub').innerHTML = `${esc(partes.join(' — '))} ${etiqueta(d.situacao)}`;
  if (!l.cnpj) {
    mostrarAviso(document.getElementById('aviso'), `Esta loja está sem CNPJ válido${d.cnpjInformado ? ` (veio "${d.cnpjInformado}")` : ''}, então não dá para ligar com o faturamento do ERP: o faturamento dela fica zero. Corrija o CNPJ na planilha de atendimentos e importe de novo.`, '');
  }
  const classe = d.situacao === 'dentro' ? 'bom' : ['fora', 'sem_faturamento'].includes(d.situacao) ? 'ruim' : '';
  document.getElementById('cards').innerHTML = `
    <div class="card"><div class="rotulo">Faturamento (parte desta loja)</div><div class="valor">${reais(d.faturamento)}</div><div class="detalhe">Só os meses com atendimento</div></div>
    <div class="card"><div class="rotulo">Custo dos promotores</div><div class="valor">${reais(d.custo)}</div><div class="detalhe">${d.promotores.length} promotor(es)</div></div>
    <div class="card ${classe}"><div class="rotulo">Custo sobre o faturamento</div><div class="valor">${pct(d.percentual)}</div><div class="detalhe">Meta: até ${pct(d.meta)}</div></div>
    <div class="card"><div class="rotulo">Visitas informadas</div><div class="valor">${d.visitas || '—'}</div></div>`;

  document.getElementById('cab-meses').innerHTML = `<tr><th>Mês</th><th class="num">Faturamento do CNPJ</th><th>Empresa</th>
    <th class="num">Lojas no CNPJ</th><th class="num">Parte desta loja</th><th class="num">Custo promotores</th><th class="num">% custo</th><th>Situação</th></tr>`;
  paginas.mostrar(d.porMes.map((m) => `
    <tr>
      <td>${rotuloMes(m.mes)}</td>
      <td class="num">${reais(m.faturamentoCnpj)}</td>
      <td>${empresasDoMes(m.empresas)}</td>
      <td class="num">${m.lojasDoCnpj || '—'}</td>
      <td class="num">${reais(m.faturamento)}</td>
      <td class="num">${reais(m.custo)}</td>
      <td class="num">${pct(m.percentual)}</td>
      <td>${etiqueta(m.situacao)}</td>
    </tr>`), '<tr><td colspan="8" class="vazio">Sem faturamento nem atendimento neste período.</td></tr>', 'meses');

  document.getElementById('painel-outras').hidden = !d.outrasLojasDoCnpj.length;
  document.getElementById('outras').innerHTML = d.outrasLojasDoCnpj.map((o) => `<li><a href="/loja?id=${o.id}">${esc(o.nome)}</a> ${esc([o.cidade, o.uf].filter(Boolean).join(' · '))}</li>`).join('');
  document.getElementById('painel-promotores').hidden = false;
  document.getElementById('promotores').innerHTML = d.promotores.map((p) => `
    <tr>
      <td><a href="/promotor?id=${p.id}">${esc(p.nome)}</a><span class="menor">${esc(TIPOS[p.tipo] || p.tipo)}${p.agencia && p.agencia !== p.nome ? ` · ${esc(p.agencia)}` : ''}</span></td>
      <td>${esc(p.dias || '—')}</td>
      <td class="num">${p.visitas || '—'}</td>
      <td class="num">${reais(p.custo)}</td>
      <td class="num">${reais(p.faturamento)}</td>
      <td class="num">${pct(p.percentual)}</td>
      <td>${etiqueta(p.situacao)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="vazio">Nenhum promotor atendeu esta loja neste período.</td></tr>';
}

async function carregarCliente(cnpj) {
  const d = await api(`/api/clientes/${cnpj}?${parametros(periodoAtual())}`);
  const c = d.cliente;
  document.title = `${c.nome} · Controle de Promotores`;
  document.getElementById('nome').textContent = c.nome;
  document.getElementById('sub').textContent = [`CNPJ ${cnpjFormatado(c.cnpj)}`, [c.cidade, c.uf].filter(Boolean).join(' · '), 'cliente do ERP'].filter(Boolean).join(' — ');
  const atendidos = d.porMes.filter((m) => m.lojasAtendidas).length;
  document.getElementById('cards').innerHTML = `
    <div class="card"><div class="rotulo">Faturamento do CNPJ no período</div><div class="valor">${reais(d.faturamento)}</div><div class="detalhe">${d.porMes.length} mês(es) com compra</div></div>
    <div class="card"><div class="rotulo">Meses com atendimento</div><div class="valor">${atendidos} de ${d.porMes.length}</div>
      <div class="detalhe">${d.lojas.length ? `${d.lojas.length} loja(s) atendida(s) com este CNPJ` : 'Nenhuma loja atendida usa este CNPJ'}</div></div>`;
  if (!d.lojas.length) {
    mostrarAviso(document.getElementById('aviso'), 'Este cliente comprou, mas nenhuma loja com este CNPJ aparece nos arquivos de atendimento do período: não tem promotor ligado a ele.', '');
  }
  document.getElementById('cab-meses').innerHTML = '<tr><th>Mês</th><th>Empresa</th><th class="num">Faturamento</th><th class="num">Lojas atendidas no mês</th><th>Situação</th></tr>';
  paginas.mostrar(d.porMes.map((m) => `
    <tr>
      <td>${rotuloMes(m.mes)}</td>
      <td>${empresasDoMes(m.empresas)}</td>
      <td class="num">${reais(m.faturamento)}</td>
      <td class="num">${m.lojasAtendidas || '—'}</td>
      <td>${etiqueta(m.lojasAtendidas ? 'dentro' : d.lojas.length ? 'sem_atendimento_no_mes' : 'sem_promotor').replace('Dentro da meta', 'Com atendimento')}</td>
    </tr>`), '<tr><td colspan="5" class="vazio">Sem faturamento neste período.</td></tr>', 'meses');
  document.getElementById('painel-lojas').hidden = !d.lojas.length;
  document.getElementById('lojas-do-cnpj').innerHTML = d.lojas.map((l) => `
    <li><a href="/loja?id=${l.id}">${esc(l.nome)}</a> ${esc([l.cidade, l.uf].filter(Boolean).join(' · '))} — atendida em ${esc(l.meses.map(rotuloMes).join(', '))}</li>`).join('');
}

(async () => {
  await iniciarPagina();
  const cnpj = endereco.get('cnpj');
  const id = cnpj ? null : idDoEndereco('Loja');
  if (cnpj && !/^\d{11,14}$/.test(cnpj)) { mostrarAviso(document.getElementById('aviso'), 'CNPJ inválido no endereço desta página. Volte para a lista e clique de novo.'); return; }
  if (!cnpj && !id) return;
  const opcoes = await carregarOpcoes();
  paginas = criarPaginacao('linhas', 'paginacao', 12);
  const carregar = async () => {
    mostrarAviso(document.getElementById('aviso'), '');
    try {
      if (cnpj) await carregarCliente(cnpj); else await carregarLoja(id);
    } catch (erro) {
      mostrarAviso(document.getElementById('aviso'), erro.message);
    }
  };
  montarPeriodo(opcoes, carregar);
  carregar();
})();
