# Controle de Promotores — 101 do Brasil

Sistema web para saber se cada promotor **"se paga"**: o custo dele precisa ser de **no máximo 3%** do faturamento das lojas que atende.

## Telas

| Tela | Endereço | O que faz |
|------|----------|-----------|
| Login | `/login` | Entrada com login e senha |
| Resumo | `/resumo` | Cards do período: faturamento total, custo total dos promotores, % do custo sobre o faturamento e promotores dentro/fora da meta |
| Lojas por UF | `/lojas-uf` | Botões por UF e tabela das lojas atendidas (supervisor, agência, promotor, CNPJ, loja, cidade, UF, visitas, valor de cada mês, total, custo, faturamento, % e situação). Ordena por coluna, oculta agências sem custo, exporta Excel e imprime |
| Agências | `/agencias` | Se cada agência vale o que custa: cartões (faturamento, custo, % contra o limite) e tabela por agência que abre os promotores e, no promotor, as lojas. Exporta Excel (3 abas) |
| Faturamento | `/faturamento` | Faturamento de cada loja com filtros (período, busca, empresa, situação), custo dos promotores na loja e exportação para Excel |
| Ficha da loja | `/loja?id=...` ou `/loja?cnpj=...` | Abre ao clicar numa linha do Faturamento. Loja atendida: faturamento do CNPJ e a parte da loja mês a mês, outras lojas do mesmo CNPJ, custo, % e promotores. Cliente do ERP sem atendimento: o faturamento do CNPJ mês a mês |
| Promotores | `/promotores` | Lista com filtros (período, busca, tipo, agência, situação, cadastro). Clicar abre a ficha |
| Ficha do promotor | `/promotor?id=...` | Cadastro completo (código, empresa, admissão, salário, periculosidade, ajuda celular, ajuda de custo/alimentação, almoço, vale-transporte, gratificação, outros), lojas que visita, dias de visita, visitas, custo, faturamento da loja e % |
| Importar | `/importar` | Importa o faturamento (FoccoERP), os atendimentos (lojas visitadas e valor) e o cadastro de promotores (salários). Mostra as colunas para conferir antes de gravar |
| Usuários | `/usuarios` | **Só o perfil suporte.** Criar, editar, redefinir senha, desativar e excluir usuários |
| Minha conta | `/conta` | O usuário troca a própria senha |

**Perfis:** `suporte` faz tudo e administra usuários; `usuario` faz tudo (importar, exportar, cadastrar), menos administrar usuários.

**Filtros** (Resumo, Faturamento, Promotores, Lojas por UF e Agências): período **Acumulado** (de/até) ou **Um mês**, Agência, Tipo, UF, Supervisor, Município e Mercado (parte do nome da loja ou da rede). Os filtros escolhidos aparecem como etiquetas com ✕ e valem para todas as telas enquanto a aba estiver aberta.

**Avisos de qualidade dos dados** aparecem no topo dessas telas quando os números estão incompletos: meses com atendimento sem faturamento do ERP, meses sem arquivo de atendimento, lojas que compraram em meses sem atendimento (com o valor que ficou fora do %), lojas sem o valor do mês, lojas sem CNPJ válido, CNPJs divididos entre lojas e promotores com salário sem loja lançada.

## Regras de cálculo

Ficam todas em [`src/calculo.js`](src/calculo.js).

1. **Meta:** `custo ÷ faturamento × 100` tem que ser **menor ou igual a 3%**. O número 3 vem da variável `META_PERCENTUAL`.
A unidade do cálculo é o **atendimento**: um promotor, numa loja, num mês. Cada atendimento tem o seu custo e a sua parte do faturamento, e todo total (por promotor, agência, UF, loja ou geral) é a soma deles. Por isso as somas batem entre si, e um filtro de UF, cidade ou loja pega só a parte do promotor nas lojas filtradas.

2. **Custo do atendimento:**
   - valor do mês informado na planilha de atendimentos: vale esse valor (agências, MEIs, freelancers);
   - sem valor, e o promotor tem custo fixo no cadastro (CLT): o custo fixo mensal (salário + periculosidade + ajuda celular + ajuda de custo/alimentação + almoço + vale-transporte + gratificação + outros) é dividido entre as lojas dele no mês, pelas visitas ou, sem visitas informadas, em partes iguais;
   - sem valor e sem cadastro: **custo não informado**. Não vira zero: fica fora do % (senão a loja pareceria dentro da meta).
3. **Faturamento do atendimento:** o faturamento do ERP é guardado por **CNPJ** e dividido na hora do cálculo:
   - o faturamento do CNPJ no mês é dividido **em partes iguais entre as lojas que usam aquele CNPJ no mês** (rede que compra pela matriz ou pelo CD);
   - a parte da loja é dividida **em partes iguais entre os promotores que a atendem no mês**;
   - **loja sem CNPJ válido fica com faturamento zero** (o custo dela pesa no %);
   - **mês sem faturamento do ERP importado:** o faturamento aparece como "—" e o mês fica fora do %;
   - o que o CNPJ comprou num mês **sem atendimento** não entra no % (aparece no aviso e, na tela Faturamento, como "Comprou sem atendimento").
   Sem filtros, a soma das linhas da tela Faturamento é exatamente o faturamento do ERP no período.
4. **Percentual:** compara só os atendimentos que têm custo conhecido e faturamento do mês importado.
5. **Promotor com custo fixo e nenhuma loja lançada no mês:** o custo entra no **custo total** (o salário foi pago), com a situação *Sem lojas*, mas não no %. Vale só para os meses que já têm atendimentos importados, para promotores ativos e já admitidos; e não entra com filtro de UF, supervisor, município ou mercado.
6. **Situações:** *Dentro da meta*, *Fora da meta*, *Sem faturamento* (o CNPJ não comprou no mês), *Sem CNPJ*, *Falta o faturamento* (mês sem ERP), *Custo não informado*, *Sem lojas*, *Sem promotor* (cliente do ERP sem atendimento), *Comprou sem atendimento*. Para agências: *Vale a pena*, *Não vale a pena*, *Falta o faturamento* e *Custo não informado*.

Pode haver diferença de centavos entre um total e a soma das linhas, por arredondamento de cada linha.

## Importação

- Aceita o **.xls do FoccoERP** (que por dentro é uma tabela HTML), **.csv** e **.xlsx**.
- **Arquivos grandes (150 MB ou mais) funcionam.** Quem lê o arquivo é o navegador, aos poucos: ele soma as linhas por loja e mês e envia ao servidor só o resultado. O arquivo inteiro nunca é enviado, então não há limite de tamanho para .xls do Focco e .csv.
- A exceção é o **.xlsx**, que o navegador não sabe abrir: ele vai para o servidor converter, com limite de 25 MB. Se passar disso, salve como .csv.
- O .xls binário do Excel antigo não é aceito (salve como .xlsx ou .csv).
- **Cargo no nome:** no cadastro, "NOME - Sup ll" vira nome "NOME" e cargo "Sup ll" (coluna `cargo`). Só separa quando o fim parece um cargo (curto, sem números nem parênteses), para não cortar nomes de agência como "101 do Brasil - Filial PR (CLT)". Os nomes que já estavam no banco são limpos ao iniciar.
- **Supervisor** (cargo "Sup.", "Sup ll", "supervisor"...) não entra no custo dos promotores nem no aviso "Promotores sem loja lançada". "Lider", "INSS" e "Lic. Maternidade" ficam como cargo, mas contam no custo.
- No relatório de faturamento do Focco, as colunas usadas são `CNPJ CPF`, `CLIENTE`, `DT EMIS`, `VLR TOTAL`, `COD EMP`, `CIDADE` e `UF`. Cada linha é um item de nota; o sistema soma tudo por cliente e mês.
- O sistema reconhece as colunas pelo nome do cabeçalho e mostra para conferir. Dá para corrigir na tela.
- Em planilhas com várias abas, ele escolhe sozinho a aba com mais colunas reconhecidas para o tipo escolhido.
- **Importar substitui o mês inteiro** (não soma, e o que saiu do arquivo some):
  - **Faturamento:** antes de gravar, apaga todo o faturamento dos **meses e empresas** que o arquivo traz. Por isso, exporte do Focco sempre o **mês inteiro** de cada empresa.
  - **Atendimentos:** apaga todos os atendimentos dos **meses** do arquivo feitos pelas **agências** do arquivo (e pelos promotores dele), inclusive os lançados à mão na tela. É por agência, e não o mês de todo mundo, porque cada agência manda o próprio arquivo: importar o arquivo da agência A não apaga o que veio da agência B. A agência é a do texto do arquivo (coluna "Agência ou MEI"); um CLT achado pelo código entra só ele, sem levar junto a agência que tem no cadastro.
  - **Cadastro de promotores:** atualiza quem já existe e cria quem não existe. Ninguém é apagado.
- **Antes de gravar**, a tela mostra o que vai ser substituído, por exemplo: "Isto vai substituir todo o mês out/2026 da empresa 60 (1.533 registros atuais)". Só grava se a pessoa confirmar.
- Linhas de total ou em branco são ignoradas e aparecem contadas no aviso final, junto com o que precisa ser conferido.

### Os três tipos de importação

| Tipo | Arquivo | O que grava |
|------|---------|-------------|
| Faturamento | `.xls` do Gerador de Relatórios do FoccoERP | Faturamento por CNPJ + mês + empresa, e nome/cidade/UF do cliente. Linhas sem CNPJ são ignoradas |
| Atendimentos | Aba **Atendimentos** do "Modelo de atendimento" (uma linha por loja atendida no mês) | Quem atende cada loja, dias de visita, visitas e valor do mês |
| Cadastro de promotores | Aba **Promotores CLT** do mesmo modelo | Código, empresa, admissão, salário e adicionais de cada promotor |

Os dois modelos em branco podem ser baixados na própria tela Importar.

### Como o sistema reconhece lojas e promotores

- **Loja:** pelo **CNPJ**. É ele que liga a planilha de atendimentos ao faturamento do Focco. Loja sem CNPJ é identificada pelo nome + cidade e **não liga com o faturamento** (fica como *Sem faturamento*).
- **CNPJ errado** (dígito verificador não confere, ou não tem 14 dígitos): a loja entra **sem CNPJ** e a importação avisa quantas são.
- **Promotor:** pelo **código + primeiro nome** (a planilha de atendimentos traz só o primeiro nome; o cadastro, o nome completo). O código é comparado sem zeros à esquerda: "06" e "6" são o mesmo. Sem código, pelo **nome + agência**: dois "João" de agências diferentes são pessoas diferentes.
- **Código sem cadastro:** quando um atendimento traz código de promotor e ninguém do cadastro tem esse código + primeiro nome, a importação avisa e as telas mostram o aviso "Código de promotor sem cadastro" com a lista. Sem cadastro não há salário, então o custo de CLT fica "não informado".
- **Linha sem nome de promotor:** o "promotor" passa a ser a própria agência da linha.
- **Texto no lugar de valor no cadastro** (ex.: "carro", "600 + 120m"): o sistema usa o primeiro número que aparecer (ou zero) e guarda o texto original na observação do promotor, para conferir.

### Banco de dados

| Tabela | O que guarda |
|--------|--------------|
| `faturamento_erp` | Faturamento do ERP por CNPJ + mês + empresa |
| `importacoes_backup` | Cópia das linhas que cada importação substituiu (para o Desfazer restaurar) |
| `clientes_erp` | Nome, cidade e UF de cada CNPJ do ERP |
| `lojas` | Lojas atendidas. Identificadas pela `chave` (CNPJ + nome + cidade): lojas da mesma rede podem ter o mesmo CNPJ |
| `visitas` | Atendimentos: promotor + loja + mês, visitas, valor, dias, status, supervisor |
| `promotores` | Cadastro. `cargo` separado do nome; `cadastrado` = veio do cadastro (planilha ou tela), e não só dos atendimentos |
| `importacoes`, `usuarios` | Histórico de importações (`restauravel` = guardou cópia) e usuários |

**Migração automática:** nas versões anteriores o faturamento ficava por loja (tabela `faturamento`). Ao iniciar, o sistema converte esses dados para `faturamento_erp` uma única vez, numa transação (se algo falhar, nada muda), e guarda uma cópia do formato antigo em `backup_faturamento_por_loja`. Lojas que só existiam por causa do faturamento (sem nenhum atendimento) viram clientes do ERP. Depois de conferir que está tudo certo, a tabela de cópia pode ser apagada.

## Tecnologias

- **Node.js + Express**: servidor e API
- **HTML, CSS e JavaScript puro**: telas (sem framework)
- **PostgreSQL**: banco de dados
- **bcryptjs + cookie-session**: login com senha criptografada
- **exceljs**: leitura e geração de planilhas

## Segurança

- **Login:** senha guardada só como hash (bcrypt). 5 erros seguidos bloqueiam aquele login para aquele endereço IP por 15 minutos; 20 erros do mesmo IP (mesmo trocando de login) bloqueiam o IP. Resposta 401 para senha errada e 429 para bloqueio.
- **Telas e API exigem login.** Sem login, as telas redirecionam para `/login` e a API responde 401. A tela e a API de usuários são só do perfil suporte.
- **Erros inesperados** mostram só uma mensagem genérica com um código (ex.: `MI2K9QZ1`). O detalhe fica no log do servidor, na linha `[erro CÓDIGO]`.
- **Entradas inválidas** (id que não é número, corpo que não é JSON, dados de importação malformados) recebem 400 antes de chegar ao banco.

## Desfazer e excluir

- **Importar → Desfazer** apaga o que a importação gravou e **restaura o que ela tinha substituído**, numa transação só. Antes de substituir um mês, a importação guarda uma cópia das linhas antigas na tabela `importacoes_backup` (`importacao_id`, `tabela`, `dados` em JSON).
- Só a **importação mais recente de cada mês e tipo** pode ser desfeita (as outras mostram "há uma mais nova"). Para voltar mais, desfaça uma por vez, da mais nova para a mais antiga.
- A importação do **cadastro de promotores não pode ser desfeita** (o botão não aparece). Corrija o promotor na tela ou importe o cadastro de novo.
- Importações feitas **antes desta versão** não guardaram cópia: o Desfazer delas só apaga, e avisa que o anterior não volta.
- Lojas, clientes do ERP e promotores cadastrados por uma importação continuam no sistema depois do Desfazer.
- **Ficha do promotor → Excluir promotor:** apaga o promotor e todos os atendimentos dele.
- O "Total" de cada linha em *Últimas importações* é o valor daquele arquivo, não o total que está no sistema.

## Por que as telas não "piscam" ao trocar

Cada item do menu é uma página separada. Para a página nova não nascer vazia, o navegador guarda na memória da aba (`sessionStorage`) a última resposta do servidor para o menu, os filtros e as listas de Resumo, Faturamento e Promotores. A tela aparece na hora com esses dados e, em seguida, confere com o servidor e atualiza se algo mudou. Essa memória é apagada ao sair do sistema, ao fechar a aba e depois de cada importação. A ficha do promotor (que tem salário) não é guardada.

## Organização do código

| Arquivo | Responsabilidade |
|---------|------------------|
| `server.js` | Liga o sistema |
| `src/config.js` | Lê as variáveis de ambiente |
| `src/db.js` | Conexão com o banco e criação das tabelas |
| `src/auth.js` | Login, perfis e usuários |
| `src/calculo.js` | As contas: monta os atendimentos, divide o faturamento, soma, situações e avisos. Não acessa o banco |
| `src/relatorios.js` | Busca os dados do período e aplica os filtros das telas |
| `public/js/planilha-comum.js` | Lê o arquivo aos poucos, reconhece as colunas e soma as linhas. Roda no navegador **e** no servidor |
| `src/planilha.js` | Converte .xlsx em linhas e monta os arquivos de exportação |
| `src/importar.js` | Confere os dados recebidos e grava faturamento e visitas |
| `src/app.js` | Rotas da API |
| `public/` | Telas (um `.html` e um `.js` por tela; `comum.js` é compartilhado) |

Tabelas: `usuarios`, `lojas`, `promotores`, `faturamento`, `visitas`, `importacoes`. Elas são criadas sozinhas quando o sistema inicia.

## Como rodar no computador

Precisa do Node.js 20 ou mais novo e de um PostgreSQL.

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha no `.env` o `DATABASE_URL`, e `ADMIN_LOGIN` + `ADMIN_SENHA` (o primeiro usuário, perfil suporte, é criado ao iniciar).

```bash
npm run dev
```

Abre em http://localhost:3000.

### Testes

```bash
npm test
```

Os testes das contas e da leitura de planilhas não precisam de banco. O teste do sistema inteiro só roda com um banco **de testes** (ele apaga os dados desse banco):

```bash
DATABASE_URL_TESTE=postgres://usuario:senha@localhost:5432/promotor_teste npm test
```

## Publicar no Render

O arquivo `render.yaml` cria o serviço web e o banco PostgreSQL juntos (Render → New → Blueprint). No painel, preencha `ADMIN_LOGIN`, `ADMIN_NOME` e `ADMIN_SENHA`.

Para migrar depois para outro banco PostgreSQL, basta trocar o `DATABASE_URL`. Os dados podem ser levados com `pg_dump` e `pg_restore`.
