// Validação da data de admissão (tela e importação).
// Aceita vazio, ou AAAA-MM-DD que existe de verdade (fevereiro não tem dia 31), com ano entre 1950 e o ano atual + 1.
// Devolve '' quando está tudo certo, ou o motivo do erro (para a mensagem de 400).
function problemaNaData(valor, agora = new Date()) {
  const texto = String(valor ?? '').trim();
  if (!texto) return '';
  const partes = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!partes) return 'use o formato AAAA-MM-DD';
  const [ano, mes, dia] = partes.slice(1).map(Number);
  const anoMaximo = agora.getFullYear() + 1;
  if (ano < 1950 || ano > anoMaximo) return `o ano precisa estar entre 1950 e ${anoMaximo}`;
  if (mes < 1 || mes > 12) return 'esse mês não existe';
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (dia < 1 || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return 'essa data não existe';
  return '';
}

module.exports = { problemaNaData };
