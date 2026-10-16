# Assinaturas no cartão e Carteira

Base: `main` em `52357e175925cba9dbfff36a9e018d3bf7a65720`.
Branch: `codex/assinaturas-cartao-carteira`.

## Decisões de arquitetura

As recorrências bancárias existentes geram obrigações ligadas a contas e podem
registrar transações de caixa. Reutilizá-las para assinaturas de cartão criaria
um segundo débito, além do pagamento da fatura. Parcelamentos também têm outra
semântica: dividem um total contratado, enquanto uma assinatura gera cobranças
mensais independentes, com prazo opcional.

A migration incremental **015** acrescenta somente estruturas de assinatura:

- `card_subscriptions`: identidade, início, dia habitual e frequência mensal.
- `card_subscription_versions`: condições completas, imutáveis, com mês de
  vigência, revisão, nome, cartão, categoria, valor, status e término opcional.
- `card_subscription_occurrences`: ajuste individual, dispensa ou confirmação,
  com a compra original e a referência explícita de inclusão em fatura manual.

As previsões são calculadas na leitura. Não há cron, materialização mensal,
cadastro financeiro de exemplo ou geração automática de compras/transações.
A confirmação explícita usa `create_card_purchase`, com **uma parcela**. O
pagamento usa `pay_card_invoice`, incluindo os recibos e travas da 014.

`planningInvoices` é o modelo compartilhado por cartões, Home, projeção,
compromissos, patrimônio e relatórios. Reutiliza `firstInvoiceDate`, a divisão
de parcelas e a composição existente das faturas. O cálculo SQL do pagamento
continua baseado em compras confirmadas, faturas informadas e ajustes.

## Regras financeiras

- Mês de cobrança e competência da fatura são conceitos diferentes. A vigência
  de uma alteração usa o **mês da cobrança**, e só depois calcula a fatura.
  A interface explica essa escolha.
- O dia do fechamento pertence à fatura ainda aberta, conforme a regra atual
  do Rota. Dias 29–31 são limitados ao último dia do mês e retomam o dia
  habitual no mês seguinte.
- Valor, cartão, status e data final da regra só mudam a partir de um mês
  futuro. Para dispensar uma cobrança ainda prevista no mês atual, existe a
  ação individual. Pausa pode ser retomada por nova versão; cancelamento é
  definitivo para a regra e mantém todo o histórico.
- O calendário do cartão fica capturado por versão. Editar fechamento ou
  vencimento cria versões de configuração para os meses futuros, preservando
  os meses anteriores e alterações já programadas de valor/cartão/status.
  Esse evento não cria cobranças, compras ou lançamentos bancários.
- Um ajuste individual de valor prevalece sobre o valor geral daquela cobrança.
  A troca futura de cartão e o calendário aplicável continuam sendo respeitados
  até a confirmação. Compras confirmadas preservam as condições originais.
- Previsões não alteram saldo bancário, despesas realizadas ou patrimônio
  líquido. Entram apenas nas projeções. A parcela prevista da fatura não fica
  disponível para pagamento: é preciso confirmar a compra ou informar o total
  da fatura. Pagar uma fatura não confirma automaticamente suas assinaturas.
- Sem fatura manual, a previsão desaparece quando sua compra é confirmada ou
  vinculada. A compra passa a ser contabilizada pelo mecanismo atual.
- Com fatura manual, seu total é a referência. Previsões sem evidência ficam
  **“A conferir na fatura informada”**, sem soma adicional. Ao confirmar uma
  nova compra, é obrigatório escolher **já incluída** ou **adicional**.
- Uma compra já existente só é vinculada pela escolha explícita de seu ID.
  Não existe associação por descrição, nome, valor ou semelhança. O vínculo
  preserva a compra e sua participação atual na fatura, inclusive após pagamentos.
- Uma compra pertence a no máximo uma ocorrência. Uma assinatura tem no máximo
  uma ocorrência por mês. Confirmar novamente não cria outra compra.
- Correções destrutivas de compras vinculadas ficam bloqueadas. O ajuste
  auditável de fatura existente continua disponível para correções posteriores.

## Segurança, auditoria e concorrência

As três tabelas têm RLS de leitura por proprietário e escrita direta revogada.
As RPCs exigem autenticação e validam cartão, categoria, assinatura, compra e
fatura do mesmo usuário por chaves compostas. Helpers que consultam dados não
ficam disponíveis diretamente a `authenticated` ou `anon`.

`financial_request_result`/`financial_requests`, introduzidos na 014, guardam o
resultado de cada pedido e rejeitam reutilização da chave com outro conteúdo.
Versões usam controle de atualização por `p_expected`. As operações adquirem
travas de cartão na mesma ordem das correções existentes, antes da assinatura.
Unicidade de ocorrência e compra protege disputas entre sessões distintas.

As três tabelas usam `capture_financial_audit`. Compras, ajustes e pagamentos
continuam nos mecanismos existentes. O snapshot e a exportação incluem as
assinaturas, versões e ocorrências, mantendo leitura de snapshots anteriores.

## Carteira e navegação

A barra continua com seis itens:
**Início | Movimentos | Novo | Carteira | Relatórios | Ajustes**.

Carteira tem acesso direto a **Contas**, **Cartões**, **Assinaturas**,
**Investimentos e reserva** e **Dívidas e parcelas**. Reutiliza os painéis,
modais e dados já carregados; não há uma segunda consulta nem implementação
financeira paralela. Ajustes mantém categorias e configuração e aponta para o
gerenciamento de contas na Carteira.

Planejamento mensal continua pela ação Planejar da Home, com visão do mês,
recorrentes bancárias, programadas e metas. Atalhos da Home para cartões,
dívidas e reserva chegam à seção correta da Carteira.

Aporte e resgate continuam no botão Novo, e posições ficam na Carteira.
Fechar modais preserva seção/mês e devolve foco ao acionador quando ele ainda
existe. Abas têm rolagem horizontal e respeitam a barra fixa e as áreas seguras
existentes do PWA.

## Validação isolada

Nenhuma migration foi aplicada remotamente. Nenhuma conta real foi populada.
Os testes de banco usam PGlite descartável, usuários A/B e dados sintéticos.
Concorrência usa um cluster PostgreSQL nativo novo em `127.0.0.1`, encerrado
ao terminar. Os testes de navegador bloqueiam tráfego externo e usam adaptador
local ou banco descartável, nunca credenciais de produção.

Comandos de validação:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:mobile
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm run test:experience
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm run test:subscriptions:mobile
PG_TEST_BIN=/caminho/postgresql/bin PG_TEST_MODULE=/caminho/pg/lib/index.js npm run test:audit:concurrency
```

`test:mobile` executa os fluxos financeiros no navegador contra PGlite e inclui
cadastro de assinatura, alteração futura, ajuste individual, confirmação e
pagamento. `test:subscriptions:mobile` verifica também 320 px, escolha de
inclusão em fatura manual, ausência de valores presumidos, foco e privacidade.

| Requisito                                                                | Evidência                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Mensalidade, meses curtos, fechamento/vencimento                         | `subscriptions-database.test.mjs`, paridade JS/SQL                                |
| Valor futuro, troca de cartão, pausa, retomada, término e cancelamento   | `subscriptions-database.test.mjs`                                                 |
| Calendário do cartão com alterações futuras já programadas               | `subscriptions-database.test.mjs`                                                 |
| Ajuste individual, confirmação e proteção da compra                      | `subscriptions-database.test.mjs`, `subscriptions-ui.test.tsx`, `test-mobile.mjs` |
| Compra manual e vínculo explícito com IDs preservados                    | `subscriptions-database.test.mjs`, `subscriptions-ui.test.tsx`                    |
| Fatura manual, inclusão/adicional e pagamento parcial/total              | `subscriptions-database.test.mjs`, `test-financial-concurrency.mjs`               |
| Caixa, histórico, patrimônio e ausência de débito duplicado              | `subscriptions-database.test.mjs`, regressões existentes, `test-mobile.mjs`       |
| RLS, escrita direta, pedidos repetidos e versão desatualizada            | `subscriptions-database.test.mjs`, `test-financial-concurrency.mjs`               |
| Sessões concorrentes, vínculo disputado, confirmação/pagamento repetidos | PostgreSQL nativo, `test-financial-concurrency.mjs`                               |
| Navegação, modais, aporte e resgate                                      | 51 testes de UI e scripts mobile                                                  |
| Migração sem alterar histórico anterior                                  | Comparação integral do snapshot 014 → 015                                         |

Os relatórios e capturas ficam em `test-results/` (ignorado pelo Git).

Resultado final no Cloud:

- `npm test`: aprovado — 10 arquivos de testes unitários, 9 de banco e
  51 testes de interface em 5 arquivos.
- `typecheck`, `lint`, `build` e `git diff --check`: aprovados.
- Navegador com PGlite e RPCs reais isoladas: **71** verificações aprovadas.
- Experiência existente em telas pequenas: **74** verificações aprovadas.
- Carteira/assinaturas em 320–430 px: **41** verificações aprovadas.
- Concorrência em PostgreSQL **18.4** nativo: **18** cenários aprovados.
- Nenhum erro de página nem tráfego externo nos três testes de navegador.

## Validação local e limites

1. Atualizar a branch e instalar dependências.
2. Aplicar a 015 **somente ao Supabase local/isolado**, após as migrations
   existentes até a 014. O cliente desta branch depende dessas tabelas.
3. Validar com usuário e cartões sintéticos: cadastro único, próximas faturas,
   ajuste individual, confirmação, vínculo explícito, pausa/cancelamento e troca
   de cartão; repetir com fatura manual e parcialmente/totalmente paga.
4. Conferir no Safari/iPhone instalado o retorno dos modais e a barra inferior.

Não há integração com operadoras: **confirmada** significa confirmação
explícita do usuário, e não verificação automática no cartão. Uma fatura manual
pode conter cobranças ainda não identificadas; por isso a escolha de inclusão
é obrigatória. Mudanças de regra/calendário valem desde o próximo mês de
cobrança; o mês atual pode ser ajustado/dispensado individualmente. O horizonte
geral continua sendo o de quatro meses já usado pelo planejamento; a seção de
assinaturas permite consultar outros meses.

As verificações de telas pequenas usam Chromium com emulação mobile, incluindo
320, 375, 390 e 430 px. Não substituem validação em Safari/iPhone físico.
O build mantém o aviso existente de bundle acima de 500 kB.

O push desta branch tem deploy automático desabilitado em `vercel.json`.
Não há merge, publicação na Vercel ou migration remota nesta entrega.

## Arquivos

- Assinaturas: `src/features/subscriptions/{types.ts,calculations.ts,SubscriptionsPanel.tsx}`.
- Schema/RPCs/travas: `supabase/migrations/202610160015_card_subscriptions.sql`.
- Navegação e composição: `src/App.tsx`, `src/features/experience/BottomNavigation.tsx`,
  `src/features/planning/{PlanningWorkspace.tsx,ui.tsx,types.ts}`.
- Faturas e modelos financeiros: `src/features/cards/{types.ts,calculations.ts,components.tsx}`,
  `src/features/planning/{calculations.ts,commitments.ts}`,
  `src/features/investments/calculations.ts`.
- Exportação: `src/features/export/{snapshot.ts,calculations.ts}`.
- Testes: `tests/{subscriptions-database.test.mjs,subscriptions-ui.test.tsx,ui.test.tsx}`;
  `scripts/{test-financial-concurrency.mjs,test-mobile.mjs,test-subscriptions-mobile.mjs,test-experience.mjs,experience-preview-data.mjs}`.
- Configuração: `package.json`, `vitest.config.ts`, `vercel.json` e este documento.
