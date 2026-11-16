// Tela Promotores: lista com filtros. Clicar em uma linha abre a ficha completa.
const filtros = () => ({
  ...periodoAtual(),
  busca: document.getElementById('busca').value.trim(),
  tipo: document.getElementById('tipo').value,
  agencia: document.getElementById('agencia').value,
  situacao: document.getElementById('situacao').value,
  ativo: document.getElementById('ativo').value,
});

async function carregar() {
  const aviso = document.getElementById('aviso');
  mostrarAviso(aviso, '');
  try {
    const { promotores } = await api(`/api/promotores?${parametros(filtros())}`);
    document.getElementById('linhas').innerHTML = promotores.map((p) => `
      <tr class="clicavel" data-id="${p.id}">
        <td><a href="/promotor?id=${p.id}">${esc(p.nome)}</a>${p.ativo ? '' : ' <span class="etiqueta">Inativo</span>'}</td>
        <td>${esc(TIPOS[p.tipo])}${(p.agencia || p.empresa) && p.agencia !== p.nome ? `<span class="menor">${esc(p.agencia || p.empresa)}</span>` : ''}</td>
        <td class="num">${p.qtdLojas}</td>
        <td class="num">${p.visitas}</td>
        <td class="num">${reais(p.custo)}</td>
        <td class="num">${reais(p.faturamento)}</td>
        <td class="num">${pct(p.percentual)}</td>
        <td>${etiqueta(p.situacao)}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="vazio">Nenhum promotor encontrado.</td></tr>';
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await api('/api/opcoes');
  document.getElementById('agencia').insertAdjacentHTML('beforeend', opcoes.agencias.map((a) => `<option>${esc(a)}</option>`).join(''));
  // O Resumo manda para cá já filtrando (ex.: /promotores?situacao=fora).
  const situacao = new URLSearchParams(location.search).get('situacao');
  if (situacao) document.getElementById('situacao').value = situacao;

  montarPeriodo(opcoes, carregar);
  document.getElementById('busca').addEventListener('input', comAtraso(carregar));
  for (const id of ['tipo', 'agencia', 'situacao', 'ativo']) document.getElementById(id).addEventListener('change', carregar);
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/promotores-exportar?${parametros(filtros())}`; });
  document.getElementById('novo').addEventListener('click', () => abrirFormPromotor(null, (id) => { location.href = `/promotor?id=${id}`; }));
  // A linha inteira é clicável (o link no nome continua funcionando para quem usa teclado).
  document.getElementById('linhas').addEventListener('click', (evento) => {
    const linha = evento.target.closest('tr[data-id]');
    if (linha && !evento.target.closest('a')) location.href = `/promotor?id=${linha.dataset.id}`;
  });
  carregar();
})();
