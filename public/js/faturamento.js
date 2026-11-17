// Tela Faturamento: lojas do período, com o custo dos promotores de cada uma.

const filtrosDaTela = () => ({
  ...filtrosAtuais(),
  busca: document.getElementById('busca').value.trim(),
  empresa: document.getElementById('empresa').value,
  situacao: document.getElementById('situacao').value,
});

let paginas = null; // controla qual página da tabela está na tela

async function carregar() {
  const aviso = document.getElementById('aviso');
  try {
    await apiComMemoria(`/api/faturamento?${parametros(filtrosDaTela())}`, ({ lojas, totais, avisos }) => {
      mostrarAviso(aviso, '');
      mostrarAvisos(avisos);
      paginas.mostrar(lojas.map((l) => {
        // Loja atendida abre a ficha da loja; cliente do ERP sem atendimento abre a ficha do CNPJ.
        const destino = l.tipo === 'loja' ? `/loja?id=${l.id}` : `/loja?cnpj=${l.cnpj}`;
        const notas = [l.cnpj ? cnpjFormatado(l.cnpj) : 'sem CNPJ'];
        if (l.lojasDoCnpj > 1) notas.push(`CNPJ dividido com ${l.lojasDoCnpj - 1} outra(s) loja(s)`);
        if (l.tipo === 'cliente') notas.push('cliente do ERP');
        return `
        <tr class="clicavel" data-destino="${destino}">
          <td><a href="${destino}">${esc(l.nome)}</a><span class="menor">${esc(notas.join(' · '))}</span></td>
          <td>${esc([l.cidade, l.uf].filter(Boolean).join(' · '))}</td>
          <td class="num">${reais(l.faturamento)}</td>
          <td class="num">${l.visitas || '—'}</td>
          <td class="num">${reais(l.custo)}</td>
          <td class="num">${pct(l.percentual)}</td>
          <td>${etiqueta(l.situacao)}</td>
        </tr>`;
      }), '<tr><td colspan="7" class="vazio">Nenhuma loja encontrada com estes filtros.</td></tr>', 'linhas');
      document.getElementById('totais').innerHTML = lojas.length ? `
        <tr><td>Total (${lojas.length} linhas)</td><td></td><td class="num">${reais(totais.faturamento)}</td><td class="num">${totais.visitas || '—'}</td>
        <td class="num">${reais(totais.custo)}</td><td class="num">${pct(totais.percentual)}</td><td></td></tr>` : '';
    });
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await carregarOpcoes();
  document.getElementById('empresa').insertAdjacentHTML('beforeend', opcoes.empresas.map((e) => `<option>${esc(e)}</option>`).join(''));
  paginas = criarPaginacao('linhas', 'paginacao');
  montarFiltros(opcoes, carregar);
  document.getElementById('busca').addEventListener('input', comAtraso(carregar));
  document.getElementById('empresa').addEventListener('change', carregar);
  document.getElementById('situacao').addEventListener('change', carregar);
  // A linha inteira é clicável (o link no nome continua funcionando para quem usa teclado).
  document.getElementById('linhas').addEventListener('click', (evento) => {
    const linha = evento.target.closest('tr[data-destino]');
    if (linha && !evento.target.closest('a')) location.href = linha.dataset.destino;
  });
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/faturamento/exportar?${parametros(filtrosDaTela())}`; });
  carregar();
})();
