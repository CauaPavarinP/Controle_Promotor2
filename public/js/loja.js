// Ficha da loja: faturamento mês a mês e os promotores que a atendem. Abre ao clicar numa loja em Faturamento.
let idLoja = null;
let paginas = null;
let opcoes = null;

async function carregar() {
  const aviso = document.getElementById('aviso');
  mostrarAviso(aviso, '');
  try {
    const d = await api(`/api/lojas/${idLoja}?${parametros(periodoAtual())}`);
    const l = d.loja;
    document.title = `${l.nome} · Controle de Promotores`;
    document.getElementById('nome').textContent = l.nome;
    const partes = [l.cnpj ? `CNPJ ${cnpjFormatado(l.cnpj)}` : 'Sem CNPJ', [l.cidade, l.uf].filter(Boolean).join(' · '), l.endereco].filter(Boolean);
    document.getElementById('sub').innerHTML = `${esc(partes.join(' — '))} ${etiqueta(d.situacao)}`;
    if (!l.cnpj) mostrarAviso(aviso, 'Esta loja está sem CNPJ, então não dá para ligar com o faturamento do FoccoERP. Preencha o CNPJ na planilha de atendimentos e importe de novo.', '');

    const classe = d.situacao === 'dentro' ? 'bom' : ['fora', 'sem_faturamento'].includes(d.situacao) ? 'ruim' : '';
    document.getElementById('cards').innerHTML = `
      <div class="card"><div class="rotulo">Faturamento no período</div><div class="valor">${reais(d.faturamento)}</div><div class="detalhe">${d.porMes.filter((m) => m.faturamento).length} mês(es) com faturamento</div></div>
      <div class="card"><div class="rotulo">Custo dos promotores</div><div class="valor">${reais(d.custo)}</div><div class="detalhe">${d.promotores.length} promotor(es)</div></div>
      <div class="card ${classe}"><div class="rotulo">Custo sobre o faturamento</div><div class="valor">${pct(d.percentual)}</div><div class="detalhe">Meta: até ${pct(d.meta)}</div></div>
      <div class="card"><div class="rotulo">Visitas informadas</div><div class="valor">${d.visitas || '—'}</div></div>`;

    paginas.mostrar(d.porMes.map((m) => `
      <tr>
        <td>${rotuloMes(m.mes)}</td>
        <td>${m.empresas.length > 1
          ? m.empresas.map((e) => `<span class="menor">${esc(e.empresa || 'sem empresa')}: ${reais(e.valor)}</span>`).join('')
          : esc(m.empresas[0] ? m.empresas[0].empresa || '—' : '—')}</td>
        <td class="num">${reais(m.faturamento)}</td>
        <td class="num">${reais(m.custo)}</td>
        <td class="num">${pct(m.percentual)}</td>
        <td>${etiqueta(m.situacao)}</td>
      </tr>`), '<tr><td colspan="6" class="vazio">Sem faturamento nem atendimento neste período.</td></tr>', 'meses');

    document.getElementById('promotores').innerHTML = d.promotores.map((p) => `
      <tr>
        <td><a href="/promotor?id=${p.id}">${esc(p.nome)}</a><span class="menor">${esc(TIPOS[p.tipo])}${p.agencia && p.agencia !== p.nome ? ` · ${esc(p.agencia)}` : ''}</span></td>
        <td>${esc(p.dias || '—')}</td>
        <td class="num">${p.visitas || '—'}</td>
        <td class="num">${reais(p.custo)}</td>
        <td class="num">${reais(p.faturamento)}</td>
        <td class="num">${pct(p.percentual)}</td>
        <td>${etiqueta(p.situacao)}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="vazio">Nenhum promotor atendeu esta loja neste período.</td></tr>';
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

(async () => {
  await iniciarPagina();
  idLoja = idDoEndereco('Loja');
  if (!idLoja) return;
  opcoes = await carregarOpcoes();
  paginas = criarPaginacao('linhas', 'paginacao', 12);
  montarPeriodo(opcoes, carregar);
  carregar();
})();
