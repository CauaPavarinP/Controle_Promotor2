// Ficha do promotor: cadastro, custos e as lojas que visita no período.
let idPromotor = null;
let detalhe = null;
let lojasCadastradas = [];

let paginas = null; // controla qual página da tabela de lojas está na tela

// manterPagina = true quando só recarregamos os mesmos dados (ex.: depois de excluir uma loja).
async function carregar(manterPagina = false) {
  const aviso = document.getElementById('aviso');
  // Aviso deixado pelo formulário: pendentes que foram ligados automaticamente a este promotor ao salvar.
  const ligacao = guardado('aviso-ligacao');
  mostrarAviso(aviso, ligacao || '', ligacao ? 'ok' : undefined);
  if (ligacao) guardar('aviso-ligacao', null);
  try {
    detalhe = await api(`/api/promotores/${idPromotor}?${parametros(periodoAtual())}`);
    const p = detalhe.promotor;
    document.title = `${p.nome} · Controle de Promotores`;
    document.getElementById('nome').textContent = p.nome;
    document.getElementById('sub').innerHTML = `${esc(TIPOS[p.tipo])}${p.agencia || p.empresa ? ` · ${esc(p.agencia || p.empresa)}` : ''} · ${p.ativo ? 'Ativo' : 'Inativo'} ${etiqueta(detalhe.situacao)}`;

    const classe = detalhe.situacao === 'dentro' ? 'bom' : ['fora', 'sem_faturamento', 'sem_lojas'].includes(detalhe.situacao) ? 'ruim' : '';
    document.getElementById('cards').innerHTML = `
      <div class="card ${classe}"><div class="rotulo">Custo sobre o faturamento</div><div class="valor">${pct(detalhe.percentual)}</div><div class="detalhe">Meta: até ${pct(detalhe.meta)}</div></div>
      <div class="card"><div class="rotulo">Custo no período</div><div class="valor">${reais(detalhe.custo)}</div></div>
      <div class="card"><div class="rotulo">Faturamento (parte dele nas lojas)</div><div class="valor">${reais(detalhe.faturamento)}</div><div class="detalhe">Loja com mais de um promotor: o faturamento é dividido entre eles</div></div>
      <div class="card"><div class="rotulo">Lojas atendidas</div><div class="valor">${detalhe.lojas.length}</div><div class="detalhe">${detalhe.visitas ? `${detalhe.visitas} visita(s) informada(s)` : 'quantidade de visitas não informada'}</div></div>`;

    const item = (rotulo, valor) => `<div><dt>${rotulo}</dt><dd>${valor}</dd></div>`;
    document.getElementById('ficha').innerHTML = [
      item('Tipo', esc(TIPOS[p.tipo])), item('Agência', esc(p.agencia || '—')), item('Empresa / grupo', esc(p.empresa || '—')),
      item('Código', esc(p.codigo || '—')), item('Cargo', esc(p.cargo || '—')), item('Região', esc(p.regiao || '—')),
      item('Supervisores no período', esc(detalhe.supervisores.join(', ') || 'nenhum')),
      item('Admissão', p.admissao ? esc(p.admissao.split('-').reverse().join('/')) : '—'), item('Telefone', esc(p.telefone || '—')),
      ...CAMPOS_DINHEIRO.map(([campo, rotulo]) => item(rotulo, reais(p[campo]))),
      item('Custo fixo mensal (soma)', reais(p.custoFixo)), item('Observação', esc(p.observacao || '—')),
    ].join('');
    const informado = detalhe.lojas.some((l) => l.atendimentos.some((a) => a.origemCusto === 'planilha'));
    const naoInformado = detalhe.lojas.some((l) => l.atendimentos.some((a) => a.custo === null));
    document.getElementById('regra').textContent = detalhe.custoSemLoja > 0
      ? `Atenção: ${reais(detalhe.custoSemLoja)} do custo deste período não tem loja lançada. Sem saber quais lojas ele atende, não dá para comparar com o faturamento.`
      : naoInformado
        ? 'Há lojas sem o valor do mês na planilha e sem salário no cadastro: o custo delas está como "não informado" e fica fora do %.'
      : informado
        ? 'Neste período, o custo veio da planilha de atendimentos (valor informado por loja).'
        : 'Sem valor por loja na planilha, o custo fixo mensal acima é dividido entre as lojas (pelas visitas; sem visitas informadas, em partes iguais).';

    paginas.mostrar(detalhe.lojas.map((l, i) => `
      <tr>
        <td><a href="/loja?id=${l.loja.id}">${esc(l.loja.nome)}</a><span class="menor">${l.loja.cnpj ? esc(cnpjFormatado(l.loja.cnpj)) : 'sem CNPJ'}${l.loja.cidade ? ` · ${esc(l.loja.cidade)}` : ''}${l.lojasDoCnpj > 1 ? ` · CNPJ dividido com ${l.lojasDoCnpj - 1} loja(s)` : ''}</span></td>
        <td>${esc(l.dias || '—')}</td>
        <td class="num">${l.visitas || '—'}</td>
        <td class="num">${reais(l.custo)}</td>
        <td class="num">${reais(l.faturamento)}</td>
        <td class="num">${pct(l.percentual)}</td>
        <td>${etiqueta(l.situacao)}</td>
        <td class="num"><button type="button" class="perigo pequeno" data-excluir="${i}" aria-label="Excluir visitas de ${esc(l.loja.nome)}">Excluir</button></td>
      </tr>`), '<tr><td colspan="8" class="vazio">Nenhuma loja lançada neste período.</td></tr>', 'lojas', manterPagina);
    document.getElementById('totais').innerHTML = detalhe.lojas.length ? `
      <tr><td>Total das lojas</td><td></td><td class="num">${detalhe.visitas || '—'}</td><td class="num">${reais(detalhe.custoSemLoja ? detalhe.custo - detalhe.custoSemLoja : detalhe.custo)}</td>
      <td class="num">${reais(detalhe.faturamento)}</td><td class="num">${pct(detalhe.percentual)}</td><td></td><td></td></tr>` : '';
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  idPromotor = idDoEndereco('Ficha do promotor');
  if (!idPromotor) return;
  const opcoes = await carregarOpcoes();
  paginas = criarPaginacao('linhas', 'paginacao');
  montarPeriodo(opcoes, () => carregar());
  await carregar();

  document.getElementById('editar').addEventListener('click', () => detalhe && abrirFormPromotor(detalhe.promotor, () => carregar(true)));
  document.getElementById('excluir').addEventListener('click', async () => {
    if (!detalhe) return;
    if (!confirm(`Excluir o promotor "${detalhe.promotor.nome}" e TODOS os atendimentos dele (de todos os meses)? Isso não pode ser desfeito.`)) return;
    try {
      await api(`/api/promotores/${idPromotor}`, { method: 'DELETE' });
      const eu = guardado('eu'); esquecerTudo(); if (eu) guardar('eu', eu); // as listas lembradas ficaram velhas
      location.href = '/promotores';
    } catch (erro) {
      mostrarAviso(document.getElementById('aviso'), erro.message);
    }
  });

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
    carregar(true);
  });

  // Lançar visita manualmente.
  const janela = document.getElementById('janela-visita');
  const texto = (l) => (l.cnpj ? `${l.nome} — ${cnpjFormatado(l.cnpj)}` : `${l.nome}${l.cidade ? ` — ${l.cidade}` : ''} (#${l.id})`);
  document.getElementById('v-mes').innerHTML = ultimosMeses().map((m) => `<option value="${m}">${rotuloMes(m)}</option>`).join('');
  document.getElementById('lancar').addEventListener('click', async () => {
    // A lista de lojas é grande: só é buscada na primeira vez que a janela abre.
    if (!lojasCadastradas.length) {
      lojasCadastradas = await api('/api/lojas');
      document.getElementById('lista-lojas').innerHTML = lojasCadastradas.map((l) => `<option value="${esc(texto(l))}"></option>`).join('');
    }
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
      carregar(true);
    } catch (erro) {
      mostrarAviso(document.getElementById('aviso-visita'), erro.message);
    }
  });
})();
