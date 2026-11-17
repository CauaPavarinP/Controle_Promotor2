// Janela de cadastro do promotor (usada na lista de Promotores e na ficha do promotor).
const CAMPOS_TEXTO = ['nome', 'tipo', 'agencia', 'codigo', 'cargo', 'empresa', 'regiao', 'admissao', 'telefone', 'observacao'];
const CAMPOS_DINHEIRO = [
  ['salario', 'Salário'], ['periculosidade', 'Periculosidade'], ['ajuda_celular', 'Ajuda celular'],
  ['ajuda_custo', 'Ajuda de custo / alimentação'], ['almoco', 'Almoço'], ['vale_transporte', 'Vale-transporte'],
  ['gratificacao', 'Gratificação'], ['outros_custos', 'Outros custos'],
];

// promotor = dados atuais (editar) ou null (novo). aoSalvar(id) é chamado depois de gravar.
function abrirFormPromotor(promotor, aoSalvar) {
  let janela = document.getElementById('janela-promotor');
  if (!janela) {
    janela = document.createElement('dialog');
    janela.id = 'janela-promotor';
    janela.innerHTML = `
      <form method="dialog">
        <h2 id="p-titulo"></h2>
        <div id="p-aviso" class="aviso" hidden></div>
        <div class="grade">
          <div class="campo inteiro"><label for="p-nome">Nome</label><input id="p-nome" required maxlength="120"></div>
          <div class="campo"><label for="p-tipo">Tipo</label>
            <select id="p-tipo"><option value="CLT">CLT</option><option value="MEI">MEI</option><option value="AGENCIA">Agência</option><option value="FREELANCER">Freelancer</option></select></div>
          <div class="campo"><label for="p-agencia">Agência (se houver)</label><input id="p-agencia" maxlength="120"></div>
          <div class="campo"><label for="p-codigo">Código / matrícula</label><input id="p-codigo" maxlength="30"></div>
          <div class="campo"><label for="p-cargo">Cargo</label><input id="p-cargo" maxlength="60" placeholder="Ex.: Promotor, Lider, Sup ll">
            <p class="ajuda">Supervisor não entra no custo dos promotores.</p></div>
          <div class="campo"><label for="p-empresa">Empresa / grupo</label><input id="p-empresa" maxlength="120"></div>
          <div class="campo"><label for="p-regiao">Região</label><input id="p-regiao" maxlength="120"></div>
          <div class="campo"><label for="p-admissao">Admissão</label><input id="p-admissao" type="date"></div>
          <div class="campo"><label for="p-telefone">Telefone</label><input id="p-telefone" maxlength="40"></div>
          ${CAMPOS_DINHEIRO.map(([campo, rotulo]) => `
            <div class="campo"><label for="p-${campo}">${rotulo} (R$ por mês)</label><input id="p-${campo}" type="number" min="0" step="0.01"></div>`).join('')}
          <div class="campo inteiro"><label for="p-observacao">Observação</label><textarea id="p-observacao" rows="2" maxlength="500"></textarea></div>
          <div class="campo inteiro"><label for="p-ativo">Cadastro</label>
            <select id="p-ativo"><option value="true">Ativo</option><option value="false">Inativo</option></select></div>
        </div>
        <p class="ajuda">Os custos mensais são usados quando a planilha de atendimentos não traz o valor por loja (caso dos CLTs).</p>
        <div class="botoes"><button type="button" class="secundario" id="p-cancelar">Cancelar</button><button type="submit">Salvar</button></div>
      </form>`;
    document.body.appendChild(janela);
    janela.querySelector('#p-cancelar').addEventListener('click', () => janela.close());
  }
  const campo = (nome) => janela.querySelector(`#p-${nome}`);
  const p = promotor || { tipo: 'CLT', ativo: true };
  campo('titulo').textContent = promotor ? 'Editar cadastro' : 'Novo promotor';
  mostrarAviso(campo('aviso'), '');
  for (const nome of CAMPOS_TEXTO) campo(nome).value = p[nome] || '';
  for (const [nome] of CAMPOS_DINHEIRO) campo(nome).value = p[nome] || '';
  campo('ativo').value = String(p.ativo !== false);

  janela.querySelector('form').onsubmit = async (evento) => {
    evento.preventDefault();
    const dados = { ativo: campo('ativo').value === 'true' };
    for (const nome of CAMPOS_TEXTO) dados[nome] = campo(nome).value;
    for (const [nome] of CAMPOS_DINHEIRO) dados[nome] = campo(nome).value;
    try {
      const resposta = promotor
        ? await api(`/api/promotores/${promotor.id}`, { method: 'PUT', json: dados })
        : await api('/api/promotores', { method: 'POST', json: dados });
      janela.close();
      aoSalvar(resposta.id);
    } catch (erro) {
      mostrarAviso(campo('aviso'), erro.message);
    }
  };
  janela.showModal();
}
