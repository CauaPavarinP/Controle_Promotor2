// Tela Faturamento: lojas do período, com o custo dos promotores de cada uma.
let opcoesDaTela = null; // listas vindas do servidor (meses com dados, empresas, agências...)

const filtros = () => ({
  ...periodoAtual(),
  busca: document.getElementById('busca').value.trim(),
  empresa: document.getElementById('empresa').value,
  situacao: document.getElementById('situacao').value,
});

let paginas = null; // controla qual página da tabela está na tela

async function carregar() {
  const aviso = document.getElementById('aviso');
  mostrarAviso(aviso, opcoesDaTela ? faltaNoPeriodo(opcoesDaTela) : '', '');
  try {
    await apiComMemoria(`/api/faturamento?${parametros(filtros())}`, ({ lojas, totais }) => {
    paginas.mostrar(lojas.map((l) => `
      <tr>
        <td>${esc(l.loja.nome)}<span class="menor">${l.loja.cnpj ? esc(cnpjFormatado(l.loja.cnpj)) : 'sem CNPJ'}</span></td>
        <td>${esc([l.loja.cidade, l.loja.uf].filter(Boolean).join(' · '))}</td>
        <td class="num">${reais(l.faturamento)}</td>
        <td class="num">${l.visitas}</td>
        <td class="num">${reais(l.custo)}</td>
        <td class="num">${l.qtdPromotores ? pct(l.percentual) : '—'}</td>
        <td>${etiqueta(l.situacao)}</td>
      </tr>`), '<tr><td colspan="7" class="vazio">Nenhuma loja encontrada neste período.</td></tr>', 'lojas');
    const pctTotal = totais.faturamento > 0 ? (totais.custo / totais.faturamento) * 100 : null;
    document.getElementById('totais').innerHTML = lojas.length ? `
      <tr><td>Total (${lojas.length} lojas)</td><td></td><td class="num">${reais(totais.faturamento)}</td><td class="num">${totais.visitas}</td>
      <td class="num">${reais(totais.custo)}</td><td class="num">${pct(pctTotal)}</td><td></td></tr>` : '';
    });
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await carregarOpcoes();
  opcoesDaTela = opcoes;
  document.getElementById('empresa').insertAdjacentHTML('beforeend', opcoes.empresas.map((e) => `<option>${esc(e)}</option>`).join(''));
  paginas = criarPaginacao('linhas', 'paginacao');
  montarPeriodo(opcoes, carregar);
  document.getElementById('busca').addEventListener('input', comAtraso(carregar));
  document.getElementById('empresa').addEventListener('change', carregar);
  document.getElementById('situacao').addEventListener('change', carregar);
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/faturamento/exportar?${parametros(filtros())}`; });
  carregar();
})();
