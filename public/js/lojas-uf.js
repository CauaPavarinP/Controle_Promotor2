// Tela Lojas por UF: uma linha por promotor + loja, com o valor informado em cada mês do período.
// Os botões de UF trocam o filtro de UF (o mesmo da barra de filtros). Ordena clicando no cabeçalho.
let dados = null;
let paginas = null;
let ordem = { campo: 'uf', direcao: 1 };

function linhasVisiveis() {
  const ocultar = document.getElementById('ocultar-sem-custo').checked;
  return dados.linhas
    .filter((l) => !ocultar || l.agenciaTemCusto)
    .sort((a, b) => comparar(a[ordem.campo], b[ordem.campo], ordem.direcao)
      || a.uf.localeCompare(b.uf) || a.agencia.localeCompare(b.agencia) || a.loja.localeCompare(b.loja));
}

function linhaHtml(l) {
  return `
    <tr>
      <td>${esc(l.supervisor || '—')}</td>
      <td>${esc(l.agencia)}</td>
      <td><a href="/promotor?id=${l.promotorId}">${esc(l.promotor)}</a><span class="menor">${esc(TIPOS[l.tipo] || l.tipo)}</span></td>
      <td class="sem-quebra">${l.cnpj ? esc(cnpjFormatado(l.cnpj)) : '<span class="menor">sem CNPJ</span>'}</td>
      <td><a href="/loja?id=${l.lojaId}">${esc(l.loja)}</a></td>
      <td>${esc(l.cidade || '—')}</td>
      <td>${esc(l.uf || '—')}</td>
      <td class="num">${l.visitas || '—'}</td>
      ${dados.meses.map((m) => `<td class="num">${reais(l.valores[m] ?? null)}</td>`).join('')}
      <td class="num">${reais(l.total)}</td>
      <td class="num">${reais(l.custo)}</td>
      <td class="num">${reais(l.faturamento)}</td>
      <td class="num">${pct(l.percentual)}</td>
      <td>${etiqueta(l.situacao)}</td>
    </tr>`;
}

function desenhar(manterPagina = false) {
  const linhas = linhasVisiveis();
  paginas.mostrar(linhas.map(linhaHtml), `<tr><td colspan="${13 + dados.meses.length}" class="vazio">Nenhuma loja atendida com estes filtros.</td></tr>`, 'linhas', manterPagina);
  // Totais de TODAS as linhas visíveis (não só da página). O % compara só o que tem custo e faturamento.
  const somar = (campo) => linhas.reduce((t, l) => (l[campo] === null || l[campo] === undefined ? t : (t ?? 0) + l[campo]), null);
  const comparaveis = linhas.filter((l) => l.custo !== null && l.faturamento !== null);
  const fat = comparaveis.reduce((t, l) => t + l.faturamento, 0);
  const pctTotal = fat > 0 ? (comparaveis.reduce((t, l) => t + l.custo, 0) / fat) * 100 : null;
  document.getElementById('totais').innerHTML = linhas.length ? `
    <tr><td colspan="7">Total (${linhas.length} linhas, ${new Set(linhas.map((l) => l.lojaId)).size} lojas)</td>
    <td class="num">${somar('visitas') || '—'}</td>
    ${dados.meses.map((m) => `<td class="num">${reais(linhas.reduce((t, l) => (l.valores[m] === undefined ? t : (t ?? 0) + l.valores[m]), null))}</td>`).join('')}
    <td class="num">${reais(somar('total'))}</td><td class="num">${reais(somar('custo'))}</td><td class="num">${reais(somar('faturamento'))}</td>
    <td class="num">${pct(pctTotal)}</td><td></td></tr>` : '';
  const ocultas = dados.linhas.length - linhas.length;
  document.getElementById('resumo-tabela').textContent = ocultas ? `${ocultas} linha(s) ocultas (agências sem nenhum custo informado).` : '';
}

function desenharCabecalho() {
  const th = (campo, rotulo, num = false) => `<th data-ordem="${campo}"${num ? ' class="num"' : ''}>${rotulo}</th>`;
  document.getElementById('cabecalho').innerHTML = `<tr>
    ${th('supervisor', 'Supervisor')}${th('agencia', 'Agência')}${th('promotor', 'Promotor')}${th('cnpj', 'CNPJ')}${th('loja', 'Loja')}
    ${th('cidade', 'Cidade')}${th('uf', 'UF')}${th('visitas', 'Visitas', true)}
    ${dados.meses.map((m) => `<th class="num">Valor ${rotuloMes(m)}</th>`).join('')}
    ${th('total', 'Total informado', true)}${th('custo', 'Custo', true)}${th('faturamento', 'Faturamento', true)}${th('percentual', '% custo', true)}${th('situacao', 'Situação')}
  </tr>`;
  ordenacaoNaTabela(document.getElementById('cabecalho'), (campo, direcao) => { ordem = { campo, direcao }; desenhar(); }, ordem);
}

function desenharBotoesUf() {
  const atual = filtrosAtuais().uf || '';
  const total = dados.ufs.reduce((t, u) => t + u.lojas, 0);
  const botao = (uf, rotulo, qtd) => `<button type="button" class="secundario pequeno" data-uf="${esc(uf)}" aria-pressed="${uf === atual}">${esc(rotulo)} (${qtd})</button>`;
  document.getElementById('botoes-uf').innerHTML = botao('', 'Todas', total)
    + dados.ufs.map((u) => botao(u.uf || '-', u.uf || 'Sem UF', u.lojas)).join(''); // "-" = lojas sem UF
}

async function carregar() {
  const aviso = document.getElementById('aviso');
  try {
    await apiComMemoria(`/api/lojas-uf?${parametros(filtrosAtuais())}`, (resposta) => {
      dados = resposta;
      mostrarAviso(aviso, '');
      mostrarAvisos(dados.avisos);
      desenharBotoesUf();
      desenharCabecalho();
      desenhar();
    });
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await carregarOpcoes();
  paginas = criarPaginacao('linhas', 'paginacao', 20);
  const ocultar = document.getElementById('ocultar-sem-custo');
  ocultar.checked = lembrado('ocultar-sem-custo') === 'sim';
  ocultar.addEventListener('change', () => { lembrar('ocultar-sem-custo', ocultar.checked ? 'sim' : 'nao'); if (dados) desenhar(); });
  montarFiltros(opcoes, carregar);
  document.getElementById('botoes-uf').addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-uf]');
    if (botao) definirFiltro('uf', botao.dataset.uf);
  });
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/lojas-uf/exportar?${parametros(filtrosAtuais())}`; });
  // Imprimir: mostra todas as linhas (não só a página atual) e volta à paginação depois.
  document.getElementById('imprimir').addEventListener('click', () => {
    if (!dados) return;
    document.getElementById('linhas').innerHTML = linhasVisiveis().map(linhaHtml).join('');
    document.getElementById('paginacao').hidden = true;
    window.print();
  });
  window.addEventListener('afterprint', () => { if (dados) desenhar(true); });
  carregar();
})();
