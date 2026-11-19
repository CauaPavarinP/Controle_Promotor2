# Controle de Promotores — 101 do Brasil

Sistema web para saber se cada promotor **"se paga"**: o custo dele precisa ser de **no máximo 3%** do faturamento das lojas que atende.

## Telas

| Tela | Endereço | O que faz |
|------|----------|-----------|
| Login | `/login` | Entrada com login e senha |
| Resumo | `/resumo` | Cards do período: faturamento total, custo total dos promotores, % do custo sobre o faturamento e promotores dentro/fora da meta |
| Lojas por UF | `/lojas-uf` | Botões por UF e tabela das lojas atendidas (supervisor, agência, promotor, CNPJ, loja, cidade, UF, visitas, valor de cada mês, total, custo, faturamento, % e situação). Ordena por coluna, oculta agências sem custo, exporta Excel e imprime |
| Supervisores | `/supervisores` | Cada supervisor e os promotores dele no período (com agência e lojas), mais os promotores sem supervisor. Botões Novo, Editar (nome e código), **Juntar** (dois cadastros que são a mesma pessoa, ex.: "Leo" e "Leonardo Silva": os vínculos passam para um e o outro é apagado, sem desfazer) e Excluir |
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
- **Supervisor não é promotor.** No cadastro, quem tem cargo de supervisor ("Sup", "Sup.", "Sup l", "Sup ll", "Supervisor"...) vai para o cadastro de **supervisores** (nome, código, cargo e empresa), sem salário, custo, tipo ou situação, e não aparece em Promotores nem nos totais. "Lider", "INSS" e "Lic. Maternidade" continuam promotores, com o cargo anotado.
- **Supervisor nos atendimentos (vínculo N:N):** a coluna "Supervisor" é separada em pessoas por vírgula, ";", "/" e " e " ("Jesus, Leo" = 2 supervisores; um nome do cadastro que contém " e " não é cortado). Cada nome é procurado sem acento e sem diferenciar maiúsculas: nome completo; senão o primeiro nome, **só se houver um único supervisor com ele**; senão o supervisor é **criado**. Cada atendimento ganha um vínculo com cada supervisor (tabela `visita_supervisor`). Um promotor pode ter vários supervisores ou nenhum. O texto original continua guardado em `visitas.supervisor`. A mensagem final da importação mostra os vínculos, os supervisores criados e os ligados pelo primeiro nome (ex.: "Jesus → JESUS ANGELS ZAPATA RIVAS"), para conferir.
- **Tela Supervisores** (só visual): cards de resumo; busca, filtro de agência e "só pendências"; ordenação; chips "37 promotores" / "17 agências" que abrem os promotores embaixo da linha, por agência; menu ⋯ (Editar, Juntar, Excluir com confirmação); marcas "Sem código" e "Nome genérico" (contam como pendência) e "Verificar" (nome completo igual ou um nome começo do outro, não conta); promotores sem supervisor em tabela por agência, com aviso de nome repetido em outra agência.
- **Melhorias futuras da tela Supervisores:** (1) no celular a tabela vira cartões e o cabeçalho que ordena some, então não há ordenação ali (dá para adicionar um seletor "Ordenar por"); (2) a marca "Verificar" compara com a lista de supervisores guardada no navegador, que é atualizada logo depois de abrir a tela, então um supervisor recém-criado em outra aba pode demorar alguns segundos (ou um recarregar) para entrar na comparação.
- **Pendência futura:** "sem supervisor" hoje é só o promotor em que **nenhum** atendimento do período tem supervisor. Quem tem parte dos atendimentos sem supervisor não aparece. Avaliar mostrar esses casos.
- O filtro "Supervisor" das telas usa o cadastro de supervisores (pelo id) e mostra os atendimentos vinculados a ele.
- **Migração automática dos supervisores** (ao iniciar, numa transação, sem repetir): (A) promotores com cargo de supervisor ou com o **nome completo** igual a um supervisor (nunca pelo primeiro nome) e **sem nenhum atendimento** saem de promotores e vão para supervisores; os dados antigos, inclusive o salário, ficam em `backup_promotores_supervisores`. Quem tem atendimento fica no aviso "Supervisor cadastrado como promotor", para resolver à mão. (B) os atendimentos que têm texto de supervisor e nenhum vínculo ganham os vínculos. O resultado sai no log do Render, nas linhas "[migração de supervisores]".
- No relatório de faturamento do Focco, as colunas usadas são `CNPJ CPF`, `CLIENTE`, `DT EMIS`, `VLR TOTAL`, `COD EMP`, `CIDADE` e `UF`. Cada linha é um item de nota; o sistema soma tudo por cliente e mês.
- O sistema reconhece as colunas pelo nome do cabeçalho e mostra para conferir. Dá para corrigir na tela.
- Em planilhas com várias abas, ele escolhe sozinho a aba com mais colunas reconhecidas para o tipo escolhido.
- **Importar complementa o que já existe: nada é apagado.** O que já está no sistema e não veio no arquivo continua (inclusive o lançado à mão na tela).
  - **Faturamento:** o registro é o **mês + CNPJ + código da empresa**. Se já existe, o valor do arquivo **substitui** o que estava; se não existe, entra. Atenção: se o Focco dividir o mesmo mês da mesma empresa em dois arquivos e o mesmo CNPJ aparecer nos dois, o segundo substitui o primeiro (não soma).
  - **Atendimentos:** o "mesmo atendimento" é o **mesmo promotor, na mesma loja, no mesmo mês**. Se não existe, entra. Se existe com os **mesmos valores**, fica como está. Se existe com **valores diferentes**, a confirmação pergunta: **Substituir** pelos valores do arquivo (padrão) ou **Somar** (visitas e valor somados; os supervisores dos dois ficam juntos). Somar o mesmo arquivo duas vezes soma de novo; se errar, use o Desfazer.
  - **Cadastro de promotores:** completa quem já existe e cria quem não existe. Ninguém é apagado. O que vier **preenchido** na planilha substitui o valor do sistema; célula **vazia** mantém o que já estava (inclusive o que foi preenchido à mão). Quem é atualizado vira cadastrado e sai das pendências.
    - **É o mesmo promotor?** Nesta ordem: (1) mesmo código (sem zeros à esquerda: "030" = "30") + mesmo primeiro nome; (2) mesmo código + mesma agência ou empresa (se só um bater); (3) mesmo nome sem acento e sem maiúsculas, preferindo quem já está cadastrado. Se nada bater, cria outro.
    - **Código diferente é pessoa diferente:** se o sistema e a planilha têm código e os códigos não batem, o nome igual não junta (cria outro e a confirmação avisa). A mesma regra vale na ligação automática de pendentes e no reconhecimento dos atendimentos.
    - Mais de um no sistema com o mesmo nome e sem código para desempatar: não mexe e avisa.
    - A confirmação lista quem vai ser **atualizado** e quem vai ser **criado** (confira a lista "Vai criar" para não duplicar).
  - **Pendentes:** salvar um promotor pela tela (ou importar o cadastro) liga automaticamente os pendentes que são a mesma pessoa (mesmo código + agência/empresa, ou mesmo nome, respeitando a regra do código diferente): os atendimentos passam para ele e o duplicado é apagado.
  - Como nada some sozinho, uma loja que saiu da agência ou um cliente corrigido no Focco continuam no sistema até alguém **desfazer a importação** ou **excluir à mão**.
- **Meses a importar:** com coluna de data no arquivo, a opção padrão é **Todos os meses do arquivo** (cada linha vai para o mês da sua data). Escolhendo um mês, só as linhas daquele mês entram (as sem data também); as outras aparecem como "Fora do mês escolhido". Sem coluna de data, é obrigatório escolher o mês, e todas as linhas vão para ele.
- **Antes de gravar**, a tela mostra por mês quantos registros são **novos** e quantos **já existem** (iguais ou com valores diferentes), com exemplos dos diferentes (ex.: "Ana – Loja A (jan/2026): no sistema 4 visitas / R$ 240,00 → no arquivo 5 visitas / R$ 300,00"). Só grava se a pessoa confirmar.
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
- **Promotor**, na importação de atendimentos (nem todo CLT, MEI ou promotor de agência tem código), nesta ordem:
  1. **com código:** código + primeiro nome (o código é comparado sem zeros à esquerda: "06" e "6" são o mesmo);
  2. **ligação feita à mão** na tela Promotores (nome da planilha + agência), guardada para as próximas importações;
  3. **nome completo + agência**, sem acento e sem diferenciar maiúsculas;
  4. **primeiro nome + agência ou empresa**, mas **só se houver um único** promotor que bata.
  - Com mais de um parecido, o sistema **não adivinha**: o promotor fica **pendente** ("Promotores não identificados"). CLT que não está no cadastro também fica pendente. Promotor de agência, MEI ou freelancer que ainda não existe é cadastrado como novo.
  - Na tela **Promotores**, o quadro "Promotores não identificados" permite escolher o promotor certo e clicar em **Ligar**: os atendimentos passam para ele, o pendente é apagado e a ligação fica guardada.
- **Código sem cadastro:** quando um atendimento traz código de promotor e ninguém do cadastro tem esse código + primeiro nome, a importação avisa e as telas mostram o aviso "Código de promotor sem cadastro" com a lista. Sem cadastro não há salário, então o custo de CLT fica "não informado".
- **Linha sem nome de promotor:** o "promotor" passa a ser a própria agência da linha.
- **Texto no lugar de valor no cadastro** (ex.: "carro", "600 + 120m"): o sistema usa o primeiro número que aparecer (ou zero) e guarda o texto original na observação do promotor, para conferir.

### Banco de dados

| Tabela | O que guarda |
|--------|--------------|
| `faturamento_erp` | Faturamento do ERP por CNPJ + mês + empresa |
| `importacoes_backup` | Cópia das linhas que cada importação substituiu (para o Desfazer restaurar) |
| `supervisores` | Supervisores: nome, código, cargo e empresa. `chave` = nome sem acento e minúsculo. `usuario_id` (opcional, ainda sem uso) prepara o futuro perfil "Supervisor" |
| `visita_supervisor` | Vínculo N:N atendimento ↔ supervisor |
| `backup_promotores_supervisores` | Cópia dos promotores que a migração moveu para supervisores |
| `vinculos_promotor` | Ligações feitas à mão: nome do promotor na planilha + agência → promotor do cadastro |
| `clientes_erp` | Nome, cidade e UF de cada CNPJ do ERP |
| `lojas` | Lojas atendidas. Identificadas pela `chave` (CNPJ + nome + cidade): lojas da mesma rede podem ter o mesmo CNPJ |
| `visitas` | Atendimentos: promotor + loja + mês, visitas, valor, dias, status e o texto original da coluna Supervisor |
| `promotores` | Cadastro. `cargo` separado do nome; `cadastrado` = veio do cadastro (planilha ou tela), e não só dos atendimentos; `pendente` = não identificado com certeza (`ambiguo` ou `nao_encontrado`) |
| `importacoes`, `usuarios` | Histórico de importações (`restauravel` = guardou cópia) e usuários |

**Migração automática:** nas versões anteriores o faturamento ficava por loja (tabela `faturamento`). Ao iniciar, o sistema converte esses dados para `faturamento_erp` uma única vez, numa transação (se algo falhar, nada muda), e guarda uma cópia do formato antigo em `backup_faturamento_por_loja`. Lojas que só existiam por causa do faturamento (sem nenhum atendimento) viram clientes do ERP. Depois de conferir que está tudo certo, a tabela de cópia pode ser apagada.

## Tecnologias

- **Node.js + Express**: servidor e API
- **HTML, CSS e JavaScript puro**: telas (sem framework)
- **PostgreSQL**: banco de dados
- **bcryptjs + cookie-session**: login com senha criptografada
- **exceljs**: leitura e geração de planilhas

## Velocidade

- **Compressão (gzip)** em todas as respostas: as listas grandes chegam cerca de 10 vezes menores (Lojas por UF, 12 meses: 383 KB → 28 KB).
- **CSS e JS com versão no endereço** (`/js/comum.js?v=<resumo do conteúdo>`): o navegador guarda o arquivo por até 1 ano e não pergunta de novo a cada tela. Quando o arquivo muda numa publicação, a versão muda e o navegador baixa o novo. As telas (HTML) continuam sem cache.
- As listas dos filtros (`/api/opcoes`) são pedidas junto com o usuário logado (`/api/eu`), e não depois.
- **Melhoria futura (segurança):** alerta moderado do `npm audit` na biblioteca `uuid` (dentro do `exceljs`). Diagnóstico e plano de correção em "Plano de Melhorias Técnicas e Segurança", item 4.
- **Plano gratuito do Render:** o servidor desliga depois de um tempo sem uso, e a primeira visita seguinte espera ele ligar de novo. Isso só some num plano pago.

## Segurança

- **Login:** senha guardada só como hash (bcrypt). 5 erros seguidos bloqueiam aquele login para aquele endereço IP por 15 minutos; 20 erros do mesmo IP (mesmo trocando de login) bloqueiam o IP. Resposta 401 para senha errada e 429 para bloqueio.
- **Telas e API exigem login.** Sem login, as telas redirecionam para `/login` e a API responde 401. A tela e a API de usuários são só do perfil suporte.
- **Erros inesperados** mostram só uma mensagem genérica com um código (ex.: `MI2K9QZ1`). O detalhe fica no log do servidor, na linha `[erro CÓDIGO]`.
- **Entradas inválidas** (id que não é número, corpo que não é JSON, dados de importação malformados) recebem 400 antes de chegar ao banco.
- **Histórico de alterações (auditoria):** cada inclusão, edição ou exclusão feita pela tela fica registrada na tabela `auditoria` (quando, quem, ação, em quê e os detalhes; nas edições, só os campos que mudaram, com o antes e o depois). O suporte vê na tela **Usuários → Histórico de alterações**. Exclusões gravam o registro na mesma transação: se o registro falhar, nada é apagado. Senhas nunca são registradas.

## Desfazer e excluir

- **Importar → Desfazer** apaga o que a importação gravou (o que entrou e o que ela alterou) e **volta como estava** o que ela alterou, numa transação só. Antes de alterar uma linha que já existia, a importação guarda a linha antiga na tabela `importacoes_backup` (`importacao_id`, `tabela`, `dados` em JSON).
- Uma importação **não** pode ser desfeita se uma importação **mais nova já alterou as mesmas linhas** (aparece "Uma importação mais nova já alterou dados desta"). Desfaça antes a mais nova. Importações que não mexem nas mesmas linhas (ex.: agência A e agência B no mesmo mês) podem ser desfeitas em qualquer ordem.
- A importação do **cadastro de promotores não pode ser desfeita** (o botão não aparece). Corrija o promotor na tela ou importe o cadastro de novo.
- Importações feitas **antes da cópia de segurança** (`restauravel = false`) mostram o botão **"Apagar (sem cópia)"**: ele só apaga, o dado anterior não volta, e só funciona se a pessoa digitar **APAGAR**.
- Lojas, clientes do ERP e promotores cadastrados por uma importação continuam no sistema depois do Desfazer.
- **Ficha do promotor → Excluir promotor:** apaga o promotor e todos os atendimentos dele.
- **Ficha do promotor → Excluir (na linha da loja):** apaga, de uma vez só, todos os atendimentos daquele promotor naquela loja no período escolhido. É tudo ou nada: se der erro, nada é apagado.
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
| `src/supervisores.js` | Supervisores (cadastro, editar, juntar) e promotores não identificados (ligar à mão) |
| `src/ligacaoSupervisor.js` | Procura ou cria os supervisores de um texto e grava os vínculos dos atendimentos |
| `scripts/backup.js`, `scripts/restaurar.js` | `npm run backup` e `npm run restaurar` (pg_dump / pg_restore) |
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

## Backup e restauração

Precisa das ferramentas do PostgreSQL (`pg_dump` e `pg_restore`) na mesma versão do banco ou mais nova (o banco do Render é PostgreSQL 16; no Neon, confira a versão do projeto no painel: se for 17, instale as ferramentas da versão 17). No Windows, vêm no instalador do PostgreSQL (marque "Command Line Tools"); no Linux, `sudo apt install postgresql-client`. Os dois comandos usam o `DATABASE_URL` do `.env`.

Fazer o backup (cria `promotor-AAAA-MM-DD_HHMMSS.dump` na pasta de backup; a pasta `backups/` do projeto não vai para o Git):

```bash
npm run backup
```

Restaurar um backup no banco do `DATABASE_URL` (**substitui** os dados atuais desse banco; pede para digitar RESTAURAR e roda numa transação só, então se falhar o banco fica como estava):

```bash
npm run restaurar -- backups/promotor-2026-11-17_103000.dump
```

### Backup semanal automático (Windows)

Opções no `.env` (todas opcionais):

| Variável | Padrão | O que faz |
|---|---|---|
| `BACKUP_PASTA` | pasta `backups` do projeto | Onde salvar. Use uma pasta da empresa que tenha cópia fora do computador (ex.: OneDrive ou pasta de rede) |
| `BACKUP_MANTER_DIAS` | `60` | Apaga cópias mais velhas que isso, **só depois de um backup novo dar certo** e **sempre mantendo as 4 mais recentes**. `0` = nunca apaga |

Segurança do script: o `pg_dump` grava num arquivo temporário (`.parcial`) e só dá o nome final se terminar certo; se falhar, nada é apagado. Só arquivos com o nome `promotor-...dump` são considerados na limpeza. Cada execução grava uma linha em `backup.log` na pasta de backup (data, OK/ERRO, arquivo e tamanho; nunca a senha).

Agendar no Agendador de Tarefas do Windows (cria ou atualiza a tarefa "Controle de Promotores - backup semanal"):

```bash
npm run agendar-backup
```

Padrão: toda segunda às 12:00. Para escolher o dia e a hora: `npm run agendar-backup -- SEX 17:30`. A tarefa roda com o seu usuário quando você está logado; se o computador estiver desligado na hora marcada, roda assim que possível. Ela chama `scripts\backup-agendado.cmd`, que guarda a saída em `backups\ultima-execucao.txt`. Testar na hora: `schtasks /Run /TN "Controle de Promotores - backup semanal"`. Remover: `schtasks /Delete /TN "Controle de Promotores - backup semanal" /F`.

O banco do Render só aceita conexões de fora pelos IPs liberados no painel dele (hoje, o da empresa). Rode os comandos de um computador da empresa, ou libere o IP em *Database → Networking*. O arquivo de backup tem dados da empresa: guarde em local seguro.

### Migrar para outro banco PostgreSQL

O sistema não depende do Render: qualquer PostgreSQL serve, só trocando o `DATABASE_URL`.

1. Faça o backup do banco atual: `npm run backup`.
2. Crie o banco novo no outro serviço e copie o endereço de conexão dele.
3. No `.env`, troque o `DATABASE_URL` pelo endereço do banco novo e restaure: `npm run restaurar -- backups/<arquivo>.dump`.
4. No Render (ou onde o sistema estiver publicado), troque a variável `DATABASE_URL` do serviço pelo endereço do banco novo. O sistema reinicia sozinho.
5. Confira as telas. Só apague o banco antigo depois de conferir.

Se preferir começar o banco novo vazio, pule os passos 1 e 3: ao iniciar, o sistema cria as tabelas sozinho.

## Publicar no Render

O arquivo `render.yaml` cria o serviço web e o banco PostgreSQL juntos (Render → New → Blueprint). No painel, preencha `ADMIN_LOGIN`, `ADMIN_NOME` e `ADMIN_SENHA`.

Para migrar depois para outro banco PostgreSQL, basta trocar o `DATABASE_URL`. Os dados podem ser levados com `pg_dump` e `pg_restore`.

## Plano de Melhorias Técnicas e Segurança

Levantamento feito lendo o código da branch principal (commit `8d27c0e`, 19/11/2026). Em cada ponto:
- **Já está certo**: o que foi conferido no código e não precisa mexer.
- **Falta**: o que vale melhorar.
- **Próximo passo**: o que fazer.

Nenhuma regra de negócio foi alterada nesta revisão. Toda mudança abaixo segue o fluxo de sempre: branch nova, PR e teste antes do merge. Mudança de tabela vira migração, mostrada antes de aplicar.

### Prioridades

| # | Melhoria | Prioridade | Esforço |
|---|----------|------------|---------|
| 2.1 | Sessão por inatividade e cookie que some ao fechar o navegador | Alta | Pequeno |
| 5.1 | Rodar os testes com banco automaticamente em todo PR (hoje são pulados sem aviso) | Alta | Pequeno |
| 1.1 | Decidir quais ações destrutivas ficam só para o suporte | Alta | Pequeno (decisão do negócio) |
| 1.2 | Registro de quem fez o quê (auditoria) | Média | Médio |
| 4 | Corrigir o alerta do `uuid` com `overrides` | Média | Pequeno |
| 2.2–2.4 | Limpar a memória mesmo se o "Sair" falhar, validade da memória, derrubar sessões ao trocar a senha | Média | Pequeno/Médio |
| 3 | Modularizar o frontend (módulos ES, `html` que escapa sozinho, estado dos filtros) | Média | Médio, aos poucos |
| 5.2 | Testes novos dos fluxos críticos | Média | Médio |
| 6 | Migrações versionadas e divisão dos arquivos grandes | Baixa | Médio |

### 1. Autorização e validação no servidor (`src/app.js`, `src/auth.js`)

**Já está certo (conferido):**
- **Login obrigatório:** toda rota `/api`, menos login e logout, passa por `exigirLogin`. Ele confere o usuário **no banco a cada chamada**: usuário desativado perde o acesso na hora.
- **Rotas de usuários:** as 4 rotas de `/api/usuarios` têm `exigirSuporte` **no servidor** (403 para o perfil usuario; há teste). A tela de Usuários também é bloqueada no servidor.
- **Suporte sempre existe:** ninguém tira o próprio acesso de suporte, e o último suporte ativo não pode ser removido.
- **Endereços validados:**
  - todo `:id` passa por `api.param('id')` (inteiro de 1 a 2.147.483.647; senão, 400);
  - `/clientes/:cnpj` aceita só 11 a 14 dígitos;
  - o período passa por `lerPeriodo` (2020-01 até o mês atual + 12).
- **Corpos validados nas funções:** `validarPromotor`, `salvarVisita`, `criarSupervisor`/`editarSupervisor`, `criarUsuario`/`atualizarUsuario`, e a importação (`MAX_ITENS`, tipo e faixa de cada valor, mês, CNPJ).
- **SQL sempre com parâmetros** (`$1`, `$2`…), nunca texto montado com dado do usuário.
- **IDOR (acessar dado "de outra pessoa" trocando o id):** não se aplica aos dados do negócio. Lojas, promotores, atendimentos e faturamento são da empresa e vistos por todos os usuários logados; não existe "dono" de registro. A única área com dono são os usuários, e ela é só do suporte.

**Falta:**
1. **Ações destrutivas abertas ao perfil usuario.**
   - Por decisão do negócio, o perfil `usuario` faz tudo, menos administrar usuários.
   - Isso inclui: excluir promotor (leva os atendimentos), excluir atendimento, desfazer importação, excluir os pendentes sem atendimento, juntar supervisores e ligar pendentes.
   - **Próximo passo:** decidir com o negócio se alguma delas fica só para o suporte. Se sim, basta pôr `auth.exigirSuporte` na rota (o mesmo filtro dos usuários) e esconder o botão na tela.
2. **Sem registro de quem fez o quê.**
   - Só a importação guarda o nome de quem importou.
   - Excluir, ligar, juntar e limpar não deixam rastro.
   - **Feito:** tabela `auditoria` e tela "Histórico de alterações" (ver a seção Segurança).
3. **SQL direto nas rotas.**
   - `DELETE /api/promotores/:id` e `DELETE /api/visitas/:id` fazem o SQL no próprio `app.js`.
   - O de visitas responde `ok` mesmo quando o id não existe (as outras rotas devolvem 404).
   - **Feito:** o SQL foi para `src/relatorios.js`, as rotas devolvem 404 e "Excluir visitas da loja" virou um pedido só, numa transação.
4. **Bloqueio de tentativas de login guardado na memória do servidor.**
   - Ele zera a cada deploy ou reinício e não funciona com mais de uma instância.
   - Hoje é aceitável (1 instância).
   - **Próximo passo:** só guardar no banco se o sistema passar a ter mais de uma instância.
5. **CSRF (site falso que dispara uma ação usando o login de quem está logado).**
   - Hoje a proteção é o cookie `SameSite=Lax` e o fato de a API só aceitar JSON ou `octet-stream`, o que obriga o navegador a pedir permissão antes de outro site enviar.
   - **Próximo passo (reforço barato):** recusar POST/PUT/DELETE cujo cabeçalho `Origin` não seja o próprio endereço do sistema.

### 2. Sessão e memória no navegador (`public/js/comum.js`)

**Já está certo (conferido):**
- **Cookie de sessão:** o `sessao` é `HttpOnly` e `SameSite=Lax`, é `Secure` em produção, e começa uma sessão nova a cada login.
- **Sem cache:** a API responde com `Cache-Control: no-store`, as telas também não ficam no cache, e há HSTS.
- **Memória das listas:**
  - fica no `sessionStorage`, que some ao fechar a aba e não passa para outras abas;
  - é apagada ao **sair**, ao **abrir a tela de login** e depois de cada importação ou alteração;
  - o apagamento na tela de login também cobre a sessão expirada, porque o 401 manda para o login;
  - respostas acima de 1,5 MB não são guardadas;
  - a ficha do promotor (com salário) não é guardada.
- **`localStorage`:** guarda só preferências (período escolhido, "ocultar sem custo").

**Falta (pensando em computador compartilhado):**
1. **A sessão dura 12 horas fixas e sobrevive a fechar o navegador.**
   - O `maxAge` cria um cookie que fica salvo no computador.
   - Quem usar o mesmo computador depois, dentro desse prazo, entra direto.
   - **Próximo passo:**
     - sessão por **inatividade** (ex.: 2 horas sem uso), renovada a cada chamada;
     - cookie **sem** `maxAge`, que some ao fechar o navegador;
     - o limite de 12 horas passa a ser conferido no servidor, por uma data gravada na sessão.
2. **O "Sair" só limpa a memória depois que o servidor responde.**
   - Ele chama `/api/logout` e só então roda `esquecerTudo()`.
   - Se a chamada falhar (sem rede), a memória fica.
   - **Próximo passo:** limpar primeiro, ou num `finally`.
3. **A memória não tem validade.**
   - Enquanto a aba estiver aberta, ficam guardados os últimos dados de **Resumo, Faturamento, Promotores, Lojas por UF e Agências**, com custos e faturamento.
   - Os dados sempre são conferidos com o servidor ao abrir a tela, mas qualquer um consegue lê-los pelo F12 (DevTools).
   - **Próximo passo:**
     - guardar junto a hora e descartar depois de alguns minutos;
     - avaliar não guardar Lojas por UF e Agências, que mostram o custo por promotor.
   - Obs.: a seção "Por que as telas não piscam" cita só Resumo, Faturamento e Promotores. No código, Lojas por UF e Agências também usam `apiComMemoria`.
4. **Sair ou trocar a senha não derruba cópias do cookie.**
   - O `cookie-session` guarda a sessão no próprio cookie, então sair não invalida uma cópia dele.
   - Trocar a senha também não derruba sessões abertas em outros computadores.
   - Desativar o usuário derruba, porque é conferido no banco.
   - **Próximo passo:**
     - criar a coluna `sessao_versao` em `usuarios` (migração nova, mostrada antes);
     - gravar esse número na sessão e conferir em `usuarioDaSessao`;
     - aumentar o número ao trocar a senha ou ao pedir "sair de todos os lugares".

### 3. Manutenção do frontend (`public/`)

**Situação atual:**
- 12 telas e cerca de 2.500 linhas em `public/js`, em JavaScript puro.
- As funções de `comum.js` são **globais**, usadas por todas as telas, e dependem da ordem dos `<script>`.
- Há 49 usos de `innerHTML`.
- O estado dos filtros fica em três lugares: nos campos da tela, no `sessionStorage` (`filtros`) e no `localStorage` (período).

**Riscos:**
- **XSS por esquecimento:**
  - cada `innerHTML` depende de lembrar de usar `esc()`;
  - a CSP atual (`default-src 'self'`) bloqueia script inline e diminui o estrago;
  - mesmo assim, um texto de planilha sem `esc()` quebraria a tela.
- **Nome trocado quebra em silêncio:** renomear uma função de `comum.js` quebra outras telas sem nenhum aviso. Não há verificação antes de publicar.
- **Filtros apagados junto com a memória:**
  - `esquecerTudo()` usa `sessionStorage.clear()`;
  - por isso, ele também apaga os filtros escolhidos depois de importar ou salvar um promotor;
  - **confirmar com o negócio** se esse comportamento atual é o desejado.
- **Telas grandes:** `supervisores.js`, `importar.js` e `planilha-comum.js` (530 linhas) misturam busca, regra de exibição e desenho. Isso facilita regressões.

**Padrões sugeridos** (sem framework e sem etapa de build; um por PR):
1. **Módulos ES** (`<script type="module">`, `import`/`export`): acabam com as globais e funcionam com a CSP atual.
2. **Template ``html`...` `` que escapa tudo sozinho**, no lugar de `innerHTML` + `esc()` manual.
3. **Um módulo de estado** (`estado.js`):
   - `lerFiltros`/`salvarFiltros`, com chaves de prefixo fixo;
   - `esquecerTudo()` passa a apagar só `memoria:*`.
4. **Cada tela separada em três partes:**
   - `carregar`: chama a API;
   - `montar`: transforma os dados no que vai aparecer; pode ser testado no Node;
   - `desenhar`: mexe no DOM.
5. **Verificação antes de publicar:** `// @ts-check` com JSDoc e um ESLint simples (`no-undef`, `no-unused-vars`), para pegar nome errado antes do deploy.
6. **Framework leve** (ex.: Preact ou Alpine): só se as telas continuarem crescendo. Hoje não é necessário.

### 4. Dependência `uuid` (alerta moderado do `npm audit`)

**Conferido:**
- O `npm audit` mostra 2 alertas moderados, os dois da mesma causa:
  - `uuid@8.3.2` (GHSA-w5hq-g745-h8pq): falta checar o limite ao usar as versões v3/v5/v6 **com buffer**;
  - ele vem pelo `exceljs@4.4.0`.
- O `exceljs@4.4.0` já é a versão mais nova publicada: não há atualização dele que resolva.
- O `exceljs` usa **só** `uuid.v4()`, sem buffer (em `cf-rule-ext-xform.js`, formatação condicional). O trecho com problema **não é usado** pelo sistema: o risco prático é baixo.
- **Não usar** `npm audit fix --force`: ele rebaixa o `exceljs` para a 3.4.0, que é incompatível e quebraria as exportações.

**Plano:**
1. Numa branch nova, adicionar ao `package.json`:
   ```json
   "overrides": { "uuid": "^11.1.1" }
   ```
   A 11.1.1 já é corrigida e ainda tem versão CommonJS, que o `exceljs` usa com `require`.
2. Rodar `npm install`, depois `npm audit` (esperado: 0 alertas) e `npm ls uuid`.
3. Testar as exportações:
   - rodar `npm test` com `DATABASE_URL_TESTE`; o teste do sistema baixa as 4 exportações e lê o `.xlsx` de volta;
   - abrir no Excel um arquivo de cada exportação e os 2 modelos.
4. Se algo quebrar:
   - tirar o `overrides`;
   - anotar aqui que o risco foi aceito (o trecho não é usado) até sair um `exceljs` novo.

### 5. Testes automatizados (`test/`)

**Hoje:**
- `calculo.test.js`: 14 testes, sem banco.
- `planilha.test.js`: 20 testes, sem banco.
- `sistema.test.js`: 29 subtestes, com banco.

Já cobrem:
- importação que complementa;
- substituir ou somar;
- desfazer na ordem certa;
- divisão do faturamento por CNPJ (nas contas e nas telas);
- 403 nas rotas de usuários;
- cookie e cabeçalhos;
- bloqueio de login;
- regras de pendentes e de código.

**5.1 Atenção: o teste do sistema é pulado sem aviso.**
- Sem `DATABASE_URL_TESTE`, o `npm test` "passa" sem ter testado o banco, a API e as permissões.
- Não há testes automáticos no GitHub (a pasta `.github/` não existe).
- **Próximo passo:**
  - um GitHub Actions com PostgreSQL 16 rodando `npm test` em todo PR;
  - no CI, falhar se a variável faltar.

**5.2 Fluxos que precisam de testes novos:**

| Fluxo | O que testar |
|-------|--------------|
| Permissões da API | Uma tabela com **todas** as rotas de escrita × sem login (401), usuario e suporte, que falhe se uma rota nova nascer sem `exigirLogin` ou sem `exigirSuporte` quando precisar |
| Importação | Duas importações ao mesmo tempo da mesma agência e mês; `.xlsx` acima de 25 MB e corpo acima de 50 MB (413); o mesmo promotor repetido na planilha de cadastro |
| Desfazer | Desfazer depois de **ligar um pendente à mão** (os atendimentos mudaram de promotor); desfazer depois de **excluir um promotor**; desfazer faturamento quando outra empresa tem o mesmo CNPJ e mês |
| Divisão do faturamento por CNPJ | CNPJ que ganha ou perde loja entre meses do mesmo período; filtros de supervisor e de agência com CNPJ dividido; total das telas = total do ERP com filtros combinados |
| Exportações | Conferir o **conteúdo** das colunas comparando com a tela, e não só o status 200 |
| Sessão (depois do item 2) | Expiração por inatividade; "Sair" limpando a memória mesmo sem rede |
| Telas | Hoje não há nenhum teste de tela. Começar com Playwright e 3 roteiros: login → Resumo; importar um arquivo de exemplo → desfazer; sair → `sessionStorage` vazio |

### 6. Outros pontos de arquitetura

- **Migrações:**
  - o `src/db.js` roda o bloco `ATUALIZACOES` inteiro a cada início, com `IF NOT EXISTS`;
  - funciona, mas não registra o que já rodou nem permite desfazer;
  - **próximo passo:** tabela `migracoes` (nome, aplicada_em) e arquivos numerados numa pasta `migracoes/`.
- **Arquivos grandes:**
  - dividir `src/importar.js` (857 linhas) por tipo: faturamento, atendimentos, cadastro e desfazer;
  - dividir também `src/relatorios.js` (535 linhas);
  - tirar do `src/app.js` a montagem das exportações, levando para `src/exportacoes.js`.
- **Este README está desatualizado em dois lugares:**
  - a tabela "Organização do código" não tem `src/ligacaoPromotor.js` e `src/datas.js`;
  - a lista de tabelas não tem `clientes_erp`, `faturamento_erp`, `supervisores`, `vinculos_promotor`, `visita_supervisor` e `importacoes_backup`.
