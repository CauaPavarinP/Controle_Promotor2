// Tela Resumo: os cards com os números do período.
let opcoes = null; // listas vindas do servidor (meses com dados, meta...)

async function carregar() {
  const aviso = document.getElementById('aviso');
  mostrarAviso(aviso, '');
  try {
    const { de, ate } = periodoAtual();
    const r = await api(`/api/resumo?${parametros({ de, ate })}`);
    const semDados = !opcoes.meses.length;
    document.getElementById('primeiros-passos').hidden = !semDados;
    if (!semDados) mostrarAviso(aviso, faltaNoPeriodo(opcoes), '');

    const classe = r.situacao === 'dentro' ? 'bom' : r.situacao === 'fora' || r.situacao === 'sem_faturamento' ? 'ruim' : '';
    const outros = [r.semFaturamento && `${r.semFaturamento} sem faturamento`, r.semLojas && `${r.semLojas} sem lojas`].filter(Boolean);
    const semFat = outros.length ? ` · ${outros.join(' · ')}` : '';
    document.getElementById('cards').innerHTML = `
      <div class="card">
        <div class="rotulo">Faturamento total</div>
        <div class="valor">${reais(r.faturamentoTotal)}</div>
        <div class="detalhe">${reais(r.faturamentoAtendido)} em lojas com promotor</div>
      </div>
      <div class="card">
        <div class="rotulo">Custo total dos promotores</div>
        <div class="valor">${reais(r.custoTotal)}</div>
        <div class="detalhe">${r.promotores} promotor(es)${r.custoSemLojas ? ` · ${reais(r.custoSemLojas)} sem loja lançada` : ''}</div>
      </div>
      <div class="card ${classe}">
        <div class="rotulo">Custo sobre o faturamento</div>
        <div class="valor">${pct(r.percentual)}</div>
        <div class="detalhe">Meta: até ${pct(r.meta)} do faturamento das lojas atendidas</div>
      </div>
      <div class="card">
        <div class="rotulo">Promotores dentro e fora da meta</div>
        <div class="valor">${r.dentro} dentro · ${r.fora} fora</div>
        <div class="detalhe"><a href="/promotores?situacao=fora">Ver os que estão fora</a>${semFat}</div>
      </div>`;
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  opcoes = await api('/api/opcoes');
  document.getElementById('meta-texto').textContent = `O promotor "se paga" quando custa até ${pct(opcoes.meta)} do faturamento das lojas que atende.`;
  montarPeriodo(opcoes, carregar);
  carregar();
})();
