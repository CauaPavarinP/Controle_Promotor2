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
          <td><a href="/promotor?id=${p.id}">${esc(p.nome)}</a>${p.ativo ? '' : ' <span class="etiqueta">Inativo</span>'}${p.pendente ? ' <span class="etiqueta sem_cnpj" title="Ligue ao promotor certo no quadro acima">Não identificado</span>' : ''}${p.cargo ? `<span class="menor">${esc(p.cargo)}</span>` : ''}</td>
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

// Quadro "Promotores não identificados": escolher o promotor do cadastro e ligar.
async function carregarPendentes() {
  const { pendentes, cadastro } = await api('/api/promotores/nao-identificados');
  document.getElementById('nao-identificados').hidden = !pendentes.length;
  const porId = new Map(cadastro.map((c) => [c.id, c]));
  const rotulo = (c) => `${c.nome} — ${c.agencia || c.empresa || 'sem agência'}${c.codigo ? ` (cód. ${c.codigo})` : ''}`;
  const motivo = { ambiguo: 'Mais de um parecido no cadastro', nao_encontrado: 'CLT que não está no cadastro' };
  document.getElementById('pendentes').innerHTML = pendentes.map((p) => `
    <tr>
      <td><strong>${esc(p.nome)}</strong><span class="menor">${esc(p.agencia || 'sem agência')}${p.codigo ? ` · código ${esc(p.codigo)}` : ''}${p.meses ? ` · ${esc(p.meses.split(', ').map(rotuloMes).join(', '))}` : ''}</span></td>
      <td>${esc(motivo[p.pendente] || p.pendente)}</td>
      <td class="num">${p.lojas}</td>
      <td><label class="sr-only" for="ligar-${p.id}">Promotor do cadastro para ${esc(p.nome)}</label>
        <select id="ligar-${p.id}">
          <option value="">Escolha…</option>
          ${p.candidatos.length ? `<optgroup label="Mesmo primeiro nome">${p.candidatos.map((id) => `<option value="${id}">${esc(rotulo(porId.get(id)))}</option>`).join('')}</optgroup>` : ''}
          <optgroup label="Todos">${cadastro.map((c) => `<option value="${c.id}">${esc(rotulo(c))}</option>`).join('')}</optgroup>
        </select></td>
      <td class="num"><button type="button" class="pequeno" data-ligar="${p.id}">Ligar</button></td>
    </tr>`).join('');
}

(async () => {
  await iniciarPagina();
  carregarPendentes().catch((erro) => mostrarAviso(document.getElementById('aviso'), erro.message));
  document.getElementById('pendentes').addEventListener('click', async (evento) => {
    const botao = evento.target.closest('button[data-ligar]');
    if (!botao) return;
    const destino = document.getElementById(`ligar-${botao.dataset.ligar}`);
    if (!destino.value) return mostrarAviso(document.getElementById('aviso'), 'Escolha o promotor do cadastro antes de ligar.');
    try {
      const r = await api(`/api/promotores/${botao.dataset.ligar}/ligar`, { method: 'POST', json: { destinoId: Number(destino.value) } });
      mostrarAviso(document.getElementById('aviso'), `Ligado a ${r.promotor}: ${r.atendimentos} atendimento(s) passaram para ele. As próximas importações já usam esta ligação.`, 'ok');
      const eu = guardado('eu'); esquecerTudo(); if (eu) guardar('eu', eu); // as listas lembradas ficaram velhas
      await carregarPendentes();
      carregar();
    } catch (erro) {
      mostrarAviso(document.getElementById('aviso'), erro.message);
    }
  });
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
