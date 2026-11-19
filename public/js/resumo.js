// Tela Resumo: os cards com os números do período.
let opcoes = null; // listas vindas do servidor (meses com dados, meta...)

async function carregar() {
  const aviso = document.getElementById('aviso');
  try {
    await apiComMemoria(`/api/resumo?${parametros(filtrosAtuais())}`, (r) => {
      const semDados = !opcoes.meses.length;
      document.getElementById('primeiros-passos').hidden = !semDados;
      mostrarAviso(aviso, '');
      mostrarAvisos(semDados ? [] : r.avisos);

      const classe = r.situacao === 'dentro' ? 'bom' : ['fora', 'sem_faturamento'].includes(r.situacao) ? 'ruim' : '';
      // Conta só quem entra no custo do período: com atendimento lançado ou com salário no cadastro (mesmo sem loja).
      // A tela Promotores lista todos os cadastrados, inclusive quem não teve nada no período.
      const detalhesCusto = [`${r.promotores} promotor(es) com atendimento ou salário no período`];
      if (r.custoSemLojas) detalhesCusto.push(`${reais(r.custoSemLojas)} sem loja lançada`);
      if (r.custoNaoInformado) detalhesCusto.push(`${r.custoNaoInformado} com custo não informado`);
      const outros = [
        r.semLojas && `${r.semLojas} sem lojas`,
        r.faltaFaturamento && `${r.faltaFaturamento} sem faturamento para comparar`,
        r.custoNaoInformado && `${r.custoNaoInformado} com custo não informado`,
      ].filter(Boolean);
      document.getElementById('cards').innerHTML = `
        <div class="card">
          <div class="rotulo">Faturamento total</div>
          <div class="valor">${reais(r.faturamentoTotal)}</div>
          <div class="detalhe">${r.faturamentoTotal === null ? 'Faturamento do ERP não importado no período'
            : `${reais(r.faturamentoAtendido)} nas lojas atendidas · ${reais(r.faturamentoSemAtendimento)} sem atendimento no mês`}</div>
        </div>
        <div class="card">
          <div class="rotulo">Custo total dos promotores</div>
          <div class="valor">${reais(r.custoTotal)}</div>
          <div class="detalhe">${detalhesCusto.join(' · ')}</div>
        </div>
        <div class="card ${classe}">
          <div class="rotulo">Custo sobre o faturamento</div>
          <div class="valor">${pct(r.percentual)}</div>
          <div class="detalhe">Meta: até ${pct(r.meta)}. Compara ${reais(r.custoComparavel)} de custo com ${reais(r.faturamentoComparavel)} de faturamento (só lojas com custo e com o faturamento do mês importado).</div>
        </div>
        <div class="card">
          <div class="rotulo">Promotores dentro e fora da meta</div>
          <div class="valor">${r.dentro} dentro · ${r.fora} fora</div>
          <div class="detalhe"><a href="/promotores?situacao=fora">Ver os que estão fora</a>${outros.length ? ` · ${outros.join(' · ')}` : ''}</div>
        </div>`;
    });
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  opcoes = await carregarOpcoes();
  document.getElementById('meta-texto').textContent = `O promotor "se paga" quando custa até ${pct(opcoes.meta)} do faturamento das lojas que atende.`;
  montarFiltros(opcoes, carregar);
  carregar();
})();
