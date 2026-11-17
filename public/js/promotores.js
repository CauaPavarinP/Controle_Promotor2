// Tela Promotores: lista com filtros. Clicar em uma linha abre a ficha completa.
// Com filtro de UF, município ou mercado, o custo e o faturamento de cada promotor são só a parte dele
// nas lojas filtradas.
const filtrosDaTela = () => ({
  ...filtrosAtuais(),
  busca: document.getElementById('busca').value.trim(),
  situacao: document.getElementById('situacao').value,
  ativo: document.getElementById('ativo').value,
});

let paginas = null; // controla qual página da tabela está na tela

async function carregar() {
  const aviso = document.getElementById('aviso');
  try {
    await apiComMemoria(`/api/promotores?${parametros(filtrosDaTela())}`, ({ promotores, avisos }) => {
      mostrarAviso(aviso, '');
      mostrarAvisos(avisos);
      paginas.mostrar(promotores.map((p) => `
        <tr class="clicavel" data-id="${p.id}">
          <td><a href="/promotor?id=${p.id}">${esc(p.nome)}</a>${p.ativo ? '' : ' <span class="etiqueta">Inativo</span>'}</td>
          <td>${esc(TIPOS[p.tipo] || p.tipo)}${p.agencia && p.agencia !== p.nome ? `<span class="menor">${esc(p.agencia)}</span>` : ''}</td>
          <td class="num">${p.qtdLojas}</td>
          <td class="num">${p.visitas || '—'}</td>
          <td class="num">${reais(p.custo)}${p.custoSemLoja ? `<span class="menor">${reais(p.custoSemLoja)} sem loja</span>` : ''}</td>
          <td class="num">${reais(p.faturamento)}</td>
          <td class="num">${pct(p.percentual)}</td>
          <td>${etiqueta(p.situacao)}</td>
        </tr>`), '<tr><td colspan="8" class="vazio">Nenhum promotor encontrado com estes filtros.</td></tr>', 'promotores');
    });
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await carregarOpcoes();
  // O Resumo manda para cá já filtrando (ex.: /promotores?situacao=fora).
  const situacao = new URLSearchParams(location.search).get('situacao');
  if (situacao) document.getElementById('situacao').value = situacao;

  paginas = criarPaginacao('linhas', 'paginacao');
  montarFiltros(opcoes, carregar);
  document.getElementById('busca').addEventListener('input', comAtraso(carregar));
  for (const id of ['situacao', 'ativo']) document.getElementById(id).addEventListener('change', carregar);
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/promotores-exportar?${parametros(filtrosDaTela())}`; });
  document.getElementById('novo').addEventListener('click', () => abrirFormPromotor(null, (id) => { location.href = `/promotor?id=${id}`; }));
  // A linha inteira é clicável (o link no nome continua funcionando para quem usa teclado).
  document.getElementById('linhas').addEventListener('click', (evento) => {
    const linha = evento.target.closest('tr[data-id]');
    if (linha && !evento.target.closest('a')) location.href = `/promotor?id=${linha.dataset.id}`;
  });
  carregar();
})();
