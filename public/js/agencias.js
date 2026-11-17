// Tela Agências: mostra se cada agência vale o que custa. Clicar na agência abre os promotores dela;
// clicar no promotor abre as lojas. O % compara o custo do atendimento com o faturamento das lojas atendidas.
let dados = null;
const abertos = new Set(); // agências e promotores abertos ("a:Nome" / "p:Nome:id"), para não fechar ao recarregar

const tipos = (lista) => lista.map((t) => TIPOS[t] || t).join(', ');
const numeros = (x) => `
  <td class="num">${reais(x.custo)}</td>
  <td class="num">${reais(x.faturamento)}</td>
  <td class="num">${pct(x.percentual)}</td>
  <td>${etiqueta(x.situacao)}</td>`;

function botaoAbrir(chave, rotulo) {
  const aberto = abertos.has(chave);
  return `<button type="button" class="abrir" data-abrir="${esc(chave)}" aria-expanded="${aberto}">
    <span class="seta" aria-hidden="true">${aberto ? '▾' : '▸'}</span>${esc(rotulo)}</button>`;
}

function desenhar() {
  const linhas = [];
  for (const a of dados.agencias) {
    const chaveA = `a:${a.nome}`;
    linhas.push(`<tr>
      <td>${botaoAbrir(chaveA, a.nome)}</td><td>${esc(tipos(a.tipos))}</td>
      <td class="num">${a.qtdPromotores}</td><td class="num">${a.qtdLojas}</td><td class="num">${a.visitas || '—'}</td>${numeros(a)}</tr>`);
    if (!abertos.has(chaveA)) continue;
    for (const p of a.promotores) {
      const chaveP = `p:${a.nome}:${p.id}`;
      linhas.push(`<tr class="nivel-1">
        <td>${botaoAbrir(chaveP, p.nome)} <a href="/promotor?id=${p.id}" class="link-ficha">ficha</a></td><td>${esc(TIPOS[p.tipo] || p.tipo)}</td>
        <td></td><td class="num">${p.lojas.length}</td><td class="num">${p.visitas || '—'}</td>${numeros(p)}</tr>`);
      if (!abertos.has(chaveP)) continue;
      for (const l of p.lojas) {
        linhas.push(`<tr class="nivel-2">
          <td><a href="/loja?id=${l.loja.id}">${esc(l.loja.nome)}</a><span class="menor">${esc([l.loja.cnpj ? cnpjFormatado(l.loja.cnpj) : 'sem CNPJ', l.loja.cidade, l.loja.uf].filter(Boolean).join(' · '))}</span></td>
          <td>${esc(l.dias || '')}</td><td></td><td></td><td class="num">${l.visitas || '—'}</td>${numeros(l)}</tr>`);
      }
    }
  }
  document.getElementById('linhas').innerHTML = linhas.join('') || '<tr><td colspan="9" class="vazio">Nenhuma agência com atendimento nestes filtros.</td></tr>';
  const soma = (campo) => dados.agencias.reduce((t, a) => t + (a[campo] || 0), 0);
  document.getElementById('totais').innerHTML = dados.agencias.length ? `<tr><td>Total (${dados.agencias.length} agências)</td><td></td>
    <td class="num">${soma('qtdPromotores')}</td><td class="num">${soma('qtdLojas')}</td><td class="num">${soma('visitas') || '—'}</td>
    <td class="num">${reais(dados.custo)}</td><td class="num">${reais(dados.faturamento)}</td><td class="num">${pct(dados.percentual)}</td><td>${etiqueta(dados.situacao)}</td></tr>` : '';
}

function desenharCards() {
  const classe = dados.situacao === 'vale' ? 'bom' : dados.situacao === 'nao_vale' ? 'ruim' : '';
  const contar = (s) => dados.agencias.filter((a) => a.situacao === s).length;
  const distancia = dados.percentual === null ? '' : dados.percentual <= dados.meta
    ? `${pct(dados.meta - dados.percentual)} abaixo do limite` : `${pct(dados.percentual - dados.meta)} acima do limite`;
  document.getElementById('cards').innerHTML = `
    <div class="card"><div class="rotulo">Faturamento das lojas atendidas</div><div class="valor">${reais(dados.faturamento)}</div>
      <div class="detalhe">Parte do faturamento do ERP que cabe às lojas atendidas</div></div>
    <div class="card"><div class="rotulo">Custo do atendimento</div><div class="valor">${reais(dados.custo)}</div>
      <div class="detalhe">${dados.custoSemLoja ? `Não inclui ${reais(dados.custoSemLoja)} de promotores sem loja lançada` : 'Soma do custo das lojas atendidas'}</div></div>
    <div class="card ${classe}"><div class="rotulo">% do faturamento</div><div class="valor">${pct(dados.percentual)}</div>
      <div class="detalhe">Limite: ${pct(dados.meta)}${distancia ? ` · ${distancia}` : ''}</div></div>
    <div class="card"><div class="rotulo">Agências</div><div class="valor">${contar('vale')} valem · ${contar('nao_vale')} não</div>
      <div class="detalhe">${contar('falta_faturamento')} sem faturamento para comparar · ${contar('custo_nao_informado')} com custo não informado</div></div>`;
}

async function carregar() {
  const aviso = document.getElementById('aviso');
  try {
    await apiComMemoria(`/api/agencias?${parametros(filtrosAtuais())}`, (resposta) => {
      dados = resposta;
      mostrarAviso(aviso, '');
      mostrarAvisos(dados.avisos);
      desenharCards();
      desenhar();
    });
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  const opcoes = await carregarOpcoes();
  document.getElementById('meta-texto').textContent = `A agência vale o que custa quando o custo do atendimento fica até ${pct(opcoes.meta)} do faturamento das lojas dela.`;
  montarFiltros(opcoes, carregar);
  document.getElementById('linhas').addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-abrir]');
    if (!botao) return;
    const chave = botao.dataset.abrir;
    if (abertos.has(chave)) abertos.delete(chave); else abertos.add(chave);
    desenhar();
    document.querySelector(`button[data-abrir="${CSS.escape(chave)}"]`)?.focus();
  });
  document.getElementById('exportar').addEventListener('click', () => { location.href = `/api/agencias/exportar?${parametros(filtrosAtuais())}`; });
  carregar();
})();
