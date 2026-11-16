// Tela Importar: envia a planilha, mostra as colunas reconhecidas para conferir e só então grava.
const el = (id) => document.getElementById(id);
let analise = null; // resposta do servidor sobre o arquivo escolhido

const AJUDA = {
  faturamento: 'Exporte do FoccoERP o faturamento por cliente, de preferência o mês inteiro. Precisa ter o CNPJ (ou o nome) da loja e o valor.',
  visitas: 'Planilha da agência ou do promotor: loja, CNPJ, quantidade de visitas no mês e custo. Se o arquivo não tiver o nome do promotor, você escolhe abaixo.',
};
const SUBSTITUI = {
  faturamento: 'Atenção: se já existir faturamento da mesma loja, mês e empresa, o valor deste arquivo substitui o anterior (não soma).',
  visitas: 'Atenção: se já existirem visitas do mesmo promotor, loja e mês, as deste arquivo substituem as anteriores (não somam).',
};

function enviar(acao, extras = {}) {
  const arquivo = el('arquivo').files[0];
  const consulta = parametros({ tipo: el('tipo').value, arquivo: arquivo.name, ...extras });
  return api(`/api/importar/${acao}?${consulta}`, { method: 'POST', body: arquivo, headers: { 'Content-Type': 'application/octet-stream' } });
}

function mapaEscolhido() {
  const mapa = {};
  for (const seletor of document.querySelectorAll('#mapa select')) if (seletor.value !== '') mapa[seletor.dataset.campo] = Number(seletor.value);
  return mapa;
}

// Mostra só os campos extras que fazem sentido para o tipo e para as colunas escolhidas.
function ajustarExtras() {
  const tipo = el('tipo').value;
  const mapa = mapaEscolhido();
  for (const campo of document.querySelectorAll('[data-so]')) campo.hidden = campo.dataset.so !== tipo;
  const escolherPromotor = tipo === 'visitas' && mapa.promotor === undefined;
  el('campo-promotor').hidden = !escolherPromotor;
  const novo = tipo === 'visitas' && (!escolherPromotor || el('promotor').value === 'novo');
  for (const campo of document.querySelectorAll('[data-novo]')) campo.hidden = !novo;
  el('novo-nome').closest('.campo').hidden = !(escolherPromotor && el('promotor').value === 'novo');
  document.querySelector('label[for="novo-tipo"]').textContent = escolherPromotor ? 'Tipo' : 'Tipo dos promotores novos (se a planilha não disser)';
}

async function analisar(aba) {
  const aviso = el('aviso');
  mostrarAviso(aviso, '');
  el('conferencia').hidden = true;
  if (!el('arquivo').files[0]) return;
  try {
    analise = await enviar('analisar', { aba });
    const opcoesColunas = analise.colunas.map((nome, i) => `<option value="${i}">${esc(nome || `Coluna ${i + 1}`)}</option>`).join('');
    el('mapa').innerHTML = analise.campos.map(({ campo, rotulo }) => `
      <div class="campo"><label for="m-${campo}">${esc(rotulo)}</label>
        <select id="m-${campo}" data-campo="${campo}"><option value="">— não tem no arquivo —</option>${opcoesColunas}</select></div>`).join('');
    for (const [campo, coluna] of Object.entries(analise.mapa)) el(`m-${campo}`).value = coluna;
    el('aba').innerHTML = analise.abas.map((a) => `<option>${esc(a)}</option>`).join('');
    el('aba').value = analise.aba;
    el('aba-linha').hidden = analise.abas.length < 2;
    el('amostra').innerHTML = `
      <thead><tr>${analise.colunas.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${analise.amostra.map((l) => `<tr>${analise.colunas.map((_, i) => `<td>${esc(l[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    el('substitui').textContent = `${analise.totalLinhas} linha(s) no arquivo. ${SUBSTITUI[el('tipo').value]}`;
    ajustarExtras();
    el('conferencia').hidden = false;
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  }
}

async function confirmar() {
  const aviso = el('aviso');
  const tipo = el('tipo').value;
  const mapa = mapaEscolhido();
  const opcoes = { aba: analise.aba, linhaCabecalho: analise.linhaCabecalho, mapa, mes: el('mes').value };
  try {
    if (mapa.data === undefined && !opcoes.mes) throw new Error('Escolha o mês das informações (o arquivo não tem coluna de data).');
    if (tipo === 'faturamento') opcoes.empresa = el('empresa').value.trim();
    else {
      opcoes.promotorNovo = { tipo: el('novo-tipo').value, agencia: el('novo-agencia').value.trim() };
      if (mapa.promotor === undefined) {
        if (el('promotor').value === 'novo') {
          opcoes.promotorNovo.nome = el('novo-nome').value.trim();
          if (!opcoes.promotorNovo.nome) throw new Error('Informe o nome do novo promotor ou agência.');
        } else if (el('promotor').value) opcoes.promotorId = Number(el('promotor').value);
        else throw new Error('Escolha de qual promotor ou agência é este arquivo.');
      }
    }
    el('confirmar').disabled = true;
    const r = await enviar('confirmar', { opcoes: JSON.stringify(opcoes) });
    const partes = [`Importação concluída: ${r.importadas} registro(s), total ${reais(r.total)}, mês(es) ${r.meses.map(rotuloMes).join(', ')}.`];
    if (r.lojasNovas) partes.push(`${r.lojasNovas} loja(s) nova(s) cadastrada(s).`);
    if (r.promotoresNovos) partes.push(`${r.promotoresNovos} promotor(es) novo(s) cadastrado(s).`);
    if (r.ignoradas) partes.push(`${r.ignoradas} linha(s) ignorada(s): ${Object.entries(r.motivos).map(([m, n]) => `${m} (${n})`).join('; ')}.`);
    mostrarAviso(aviso, partes.join(' '), 'ok');
    el('conferencia').hidden = true;
    el('arquivo').value = '';
    await carregarListas();
  } catch (erro) {
    mostrarAviso(aviso, erro.message);
  } finally {
    el('confirmar').disabled = false;
  }
  aviso.scrollIntoView({ block: 'center' });
}

async function carregarListas() {
  const [opcoes, historico] = await Promise.all([api('/api/opcoes'), api('/api/importacoes')]);
  el('promotor').innerHTML = `<option value="">Escolha…</option>${opcoes.promotores.map((p) => `<option value="${p.id}">${esc(p.nome)} (${esc(TIPOS[p.tipo])})</option>`).join('')}<option value="novo">+ Cadastrar novo promotor ou agência</option>`;
  el('lista-empresas').innerHTML = opcoes.empresas.map((e) => `<option value="${esc(e)}"></option>`).join('');
  el('historico').innerHTML = historico.map((h) => `
    <tr>
      <td>${new Date(h.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${h.tipo === 'faturamento' ? 'Faturamento' : 'Visitas'}</td>
      <td>${esc(h.arquivo)}</td><td>${esc(h.usuario)}</td>
      <td>${esc(h.meses.split(', ').filter(Boolean).map(rotuloMes).join(', '))}</td>
      <td class="num">${h.linhas}</td><td class="num">${h.ignoradas}</td><td class="num">${reais(h.total)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="vazio">Nenhuma importação ainda.</td></tr>';
}

(async () => {
  await iniciarPagina();
  el('mes').innerHTML = `<option value="">— escolha —</option>${ultimosMeses().map((m) => `<option value="${m}">${rotuloMes(m)}</option>`).join('')}`;
  await carregarListas();
  const trocouTipo = () => { el('ajuda-tipo').textContent = AJUDA[el('tipo').value]; analisar(); };
  el('tipo').addEventListener('change', trocouTipo);
  el('arquivo').addEventListener('change', () => analisar());
  el('aba').addEventListener('change', () => analisar(el('aba').value));
  el('mapa').addEventListener('change', ajustarExtras);
  el('promotor').addEventListener('change', ajustarExtras);
  el('confirmar').addEventListener('click', confirmar);
  el('ajuda-tipo').textContent = AJUDA[el('tipo').value];
})();
