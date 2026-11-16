// Tela Faturamento: lojas do período, com o custo dos promotores de cada uma.
const filtros = () => ({
  ...periodoAtual(),
  busca: document.getElementById('busca').value.trim(),
  empresa: document.getElementById('empresa').value,
  situacao: document.getElementById('situacao').value,
});

async function carregar() {
  const aviso = document.getElementById('aviso');
  mostrarAviso(aviso, '');
  try {
    const { lojas, totais } = await api(`/api/faturamento?${parametros(filtros())}`);
    document.getElementById('linhas').innerHTML = lojas.map((l) => `
      <tr>
        <td>${esc(l.loja.nome)}<span class="menor">${l.loja.cnpj ? esc(cnpjFormatado(l.loja.cnpj)) : 'sem CNPJ'}</span></td>
        <td>${esc([l.loja.cidade, l.loja.uf].filter(Boolean).join(' · '))}</td>
        <td class="num">${reais(l.faturamento)}</td>
        <td class="num">${l.visitas}</td>
        <td class="num">${reais(l.custo)}</td>
        <td class="num">${l.qtdPromotores ? pct(l.percentual) : '—'}</td>
        <td>${etiqueta(l.situacao)}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="vazio">Nenhuma loja encontrada neste período.</td></tr>';
    const pctTotal = totais.faturamento > 0 ? (totais.custo / totais.faturamento) * 100 : null;
    document.getElementById('totais').innerHTML = lojas.length ? `
      <tr><td>Total (${lojas.length} lojas)</td><td></td><td class="num">${reais(totais.faturamento)}</td><td class="num">${totais.visitas}</td>
      <td class="num">${reais(totais.custo)}</td><td class="num">${pct(pctTotal)}</td><td></td></tr>` : '';
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await api('/api/opcoes');
  document.getElementById('empresa').insertAdjacentHTML('beforeend', opcoes.empresas.map((e) => `<option>${esc(e)}</option>`).join(''));
  montarPeriodo(opcoes, carregar);
  document.getElementById('busca').addEventListener('input', comAtraso(carregar));
  document.getElementById('empresa').addEventListener('change', carregar);
  document.getElementById('situacao').addEventListener('change', carregar);
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/faturamento/exportar?${parametros(filtros())}`; });
  carregar();
})();
