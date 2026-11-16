// Ficha do promotor: cadastro, custos e as lojas que visita no período.
const idPromotor = Number(new URLSearchParams(location.search).get('id'));
let detalhe = null;
let lojasCadastradas = [];

async function carregar() {
  const aviso = document.getElementById('aviso');
  mostrarAviso(aviso, '');
  try {
    detalhe = await api(`/api/promotores/${idPromotor}?${parametros(periodoAtual())}`);
    const p = detalhe.promotor;
    document.title = `${p.nome} · Controle de Promotores`;
    document.getElementById('nome').textContent = p.nome;
    document.getElementById('sub').innerHTML = `${esc(TIPOS[p.tipo])}${p.agencia ? ` · ${esc(p.agencia)}` : ''} · ${p.ativo ? 'Ativo' : 'Inativo'} ${etiqueta(detalhe.situacao)}`;

    const classe = detalhe.situacao === 'dentro' ? 'bom' : detalhe.situacao === 'fora' || detalhe.situacao === 'sem_faturamento' ? 'ruim' : '';
    document.getElementById('cards').innerHTML = `
      <div class="card ${classe}"><div class="rotulo">Custo sobre o faturamento</div><div class="valor">${pct(detalhe.percentual)}</div><div class="detalhe">Meta: até ${pct(detalhe.meta)}</div></div>
      <div class="card"><div class="rotulo">Custo no período</div><div class="valor">${reais(detalhe.custo)}</div></div>
      <div class="card"><div class="rotulo">Faturamento das lojas visitadas</div><div class="valor">${reais(detalhe.faturamento)}</div></div>
      <div class="card"><div class="rotulo">Visitas</div><div class="valor">${detalhe.visitas}</div><div class="detalhe">em ${detalhe.lojas.length} loja(s)</div></div>`;

    const item = (rotulo, valor) => `<div><dt>${rotulo}</dt><dd>${valor}</dd></div>`;
    document.getElementById('ficha').innerHTML = [
      item('Tipo', esc(TIPOS[p.tipo])), item('Agência', esc(p.agencia || '—')), item('Telefone', esc(p.telefone || '—')),
      ...CAMPOS_DINHEIRO.map(([campo, rotulo]) => item(rotulo, reais(p[campo]))),
      item('Custo fixo mensal (soma)', reais(p.custoFixo)), item('Observação', esc(p.observacao || '—')),
    ].join('');
    const informado = detalhe.lojas.some((l) => l.atendimentos.some((a) => a.custoInformado));
    document.getElementById('regra').textContent = informado
      ? 'Neste período, o custo veio da planilha de visitas (custo informado por loja).'
      : 'Sem custo informado na planilha, o custo fixo mensal acima é dividido entre as lojas conforme as visitas.';

    document.getElementById('linhas').innerHTML = detalhe.lojas.map((l, i) => `
      <tr>
        <td>${esc(l.loja.nome)}<span class="menor">${esc(cnpjFormatado(l.loja.cnpj))}</span></td>
        <td class="num">${l.visitas}</td>
        <td class="num">${reais(l.custo)}</td>
        <td class="num">${reais(l.faturamento)}</td>
        <td class="num">${pct(l.percentual)}</td>
        <td>${etiqueta(l.situacao)}</td>
        <td class="num"><button type="button" class="perigo pequeno" data-excluir="${i}" aria-label="Excluir visitas de ${esc(l.loja.nome)}">Excluir</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="vazio">Nenhuma visita neste período.</td></tr>';
    document.getElementById('totais').innerHTML = detalhe.lojas.length ? `
      <tr><td>Total</td><td class="num">${detalhe.visitas}</td><td class="num">${reais(detalhe.custo)}</td>
      <td class="num">${reais(detalhe.faturamento)}</td><td class="num">${pct(detalhe.percentual)}</td><td></td><td></td></tr>` : '';
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await api('/api/opcoes');
  lojasCadastradas = opcoes.lojas;
  montarPeriodo(opcoes, carregar);
  await carregar();

  document.getElementById('editar').addEventListener('click', () => detalhe && abrirFormPromotor(detalhe.promotor, carregar));

  // Excluir as visitas de uma loja (no período escolhido).
  document.getElementById('linhas').addEventListener('click', async (evento) => {
    const botao = evento.target.closest('[data-excluir]');
    if (!botao) return;
    const loja = detalhe.lojas[Number(botao.dataset.excluir)];
    if (!confirm(`Excluir as visitas de "${loja.loja.nome}" neste período? O custo delas sai da conta.`)) return;
    try {
      for (const atendimento of loja.atendimentos) await api(`/api/visitas/${atendimento.id}`, { method: 'DELETE' });
    } catch (erro) {
      mostrarAviso(document.getElementById('aviso'), erro.message);
    }
    carregar();
  });

  // Lançar visita manualmente.
  const janela = document.getElementById('janela-visita');
  const texto = (l) => (l.cnpj ? `${l.nome} — ${cnpjFormatado(l.cnpj)}` : l.nome);
  document.getElementById('lista-lojas').innerHTML = lojasCadastradas.map((l) => `<option value="${esc(texto(l))}"></option>`).join('');
  document.getElementById('v-mes').innerHTML = ultimosMeses().map((m) => `<option value="${m}">${rotuloMes(m)}</option>`).join('');
  document.getElementById('lancar').addEventListener('click', () => {
    document.getElementById('form-visita').reset();
    document.getElementById('v-mes').value = periodoAtual().ate;
    mostrarAviso(document.getElementById('aviso-visita'), '');
    janela.showModal();
  });
  document.getElementById('v-cancelar').addEventListener('click', () => janela.close());
  document.getElementById('form-visita').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const digitado = document.getElementById('v-loja').value;
    const loja = lojasCadastradas.find((l) => texto(l) === digitado);
    try {
      if (!loja) throw new Error('Escolha uma loja da lista. Lojas novas entram pela importação do faturamento ou das visitas.');
      await api('/api/visitas', { method: 'POST', json: {
        promotorId: idPromotor, lojaId: loja.id, mes: document.getElementById('v-mes').value,
        visitas: Number(document.getElementById('v-visitas').value), custo: document.getElementById('v-custo').value,
      } });
      janela.close();
      carregar();
    } catch (erro) {
      mostrarAviso(document.getElementById('aviso-visita'), erro.message);
    }
  });
})();
