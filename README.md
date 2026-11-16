# Controle de Promotores — 101 do Brasil

Sistema web para saber se cada promotor **"se paga"**: o custo dele precisa ser de **no máximo 3%** do faturamento das lojas que atende.

## Telas

| Tela | Endereço | O que faz |
|------|----------|-----------|
| Login | `/login` | Entrada com login e senha |
| Resumo | `/resumo` | Cards do período: faturamento total, custo total dos promotores, % do custo sobre o faturamento e promotores dentro/fora da meta |
| Faturamento | `/faturamento` | Faturamento de cada loja com filtros (período, busca, empresa, situação), custo dos promotores na loja e exportação para Excel |
| Promotores | `/promotores` | Lista com filtros (período, busca, tipo, agência, situação, cadastro). Clicar abre a ficha |
| Ficha do promotor | `/promotor?id=...` | Cadastro completo (salário, periculosidade, ajuda de custo, almoço, vale-transporte, outros), lojas que visita, visitas, custo, faturamento da loja e % |
| Importar | `/importar` | Importa o faturamento (FoccoERP) e as visitas (agências, CLTs, MEIs). Mostra as colunas para conferir antes de gravar |
| Usuários | `/usuarios` | **Só o perfil suporte.** Criar, editar, redefinir senha, desativar e excluir usuários |
| Minha conta | `/conta` | O usuário troca a própria senha |

**Perfis:** `suporte` faz tudo e administra usuários; `usuario` faz tudo (importar, exportar, cadastrar), menos administrar usuários.

## Regras de cálculo

Ficam todas em [`src/calculo.js`](src/calculo.js).

1. **Meta:** `custo ÷ faturamento × 100` tem que ser **menor ou igual a 3%**. O número 3 vem da variável `META_PERCENTUAL`.
2. **Custo do atendimento** (promotor + loja + mês):
   - se a planilha de visitas trouxe o custo, vale o custo da planilha;
   - se não trouxe, usa o **custo fixo mensal** do cadastro do promotor (salário + periculosidade + ajuda de custo + almoço + vale-transporte + outros), dividido entre as lojas na proporção das visitas do mês.
3. **Faturamento do promotor:** soma do faturamento das lojas **nos meses em que ele as atendeu**.
4. **Duas pessoas na mesma loja:** o faturamento da loja conta inteiro para cada uma. Na tela Faturamento, o custo da loja é a soma dos dois.
5. **Situações:** *Dentro da meta*, *Fora da meta*, *Sem faturamento* (teve custo, mas a loja não faturou no mês), *Sem dados* e *Sem promotor* (loja que faturou sem visita).

## Importação

- Aceita o **.xls do FoccoERP** (que por dentro é uma tabela HTML), **.csv** e **.xlsx**.
- **Arquivos grandes (150 MB ou mais) funcionam.** Quem lê o arquivo é o navegador, aos poucos: ele soma as linhas por loja e mês e envia ao servidor só o resultado. O arquivo inteiro nunca é enviado, então não há limite de tamanho para .xls do Focco e .csv.
- A exceção é o **.xlsx**, que o navegador não sabe abrir: ele vai para o servidor converter, com limite de 25 MB. Se passar disso, salve como .csv.
- O .xls binário do Excel antigo não é aceito (salve como .xlsx ou .csv).
- No relatório de faturamento do Focco, as colunas usadas são `CNPJ CPF`, `CLIENTE`, `DT EMIS`, `VLR TOTAL`, `COD EMP`, `CIDADE` e `UF`. Cada linha é um item de nota; o sistema soma tudo por cliente e mês.
- O sistema reconhece as colunas pelo nome do cabeçalho e mostra para conferir. Dá para corrigir na tela.
- As lojas são reconhecidas pelo **CNPJ** (sem CNPJ, pelo nome). É o CNPJ que liga a planilha da agência ao faturamento do Focco.
- **Importar de novo substitui**, não soma: faturamento por loja + mês + empresa; visitas por promotor + loja + mês. Por isso, exporte do Focco sempre o **mês inteiro**.
- Linhas de total ou em branco são ignoradas e aparecem contadas no aviso final.
- Em **Importar → Baixar modelo de visitas** há uma planilha padrão para pedir às agências.

## Tecnologias

- **Node.js + Express**: servidor e API
- **HTML, CSS e JavaScript puro**: telas (sem framework)
- **PostgreSQL**: banco de dados
- **bcryptjs + cookie-session**: login com senha criptografada
- **exceljs**: leitura e geração de planilhas

## Organização do código

| Arquivo | Responsabilidade |
|---------|------------------|
| `server.js` | Liga o sistema |
| `src/config.js` | Lê as variáveis de ambiente |
| `src/db.js` | Conexão com o banco e criação das tabelas |
| `src/auth.js` | Login, perfis e usuários |
| `src/calculo.js` | As contas (custo, %, situação). Não acessa o banco |
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
