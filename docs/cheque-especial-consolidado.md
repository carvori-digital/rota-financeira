# Cheque especial e consolidação bancária

Base verificada no GitHub: `codex/assinaturas-cartao-carteira`,
`82cd2d884b624ec22f791540af52f8565ef02c27`. A branch isolada é
`codex/cheque-especial-consolidado`. O checkout inicial estava limpo; o trabalho
anterior e as migrations 001–015 foram preservados. A main não foi mesclada.

## Invariantes contábeis

1. `accounts` + `transactions` continuam sendo o único livro bancário.
   Não há conta, receita, despesa de recuperação ou dívida automática do limite.
2. Saldo na data = saldo inicial existente + movimentos realizados até a data.
   Entradas somam; saídas subtraem; transferências têm duas pontas; ajustes usam
   seu delta. Pendentes, cancelados e movimentos futuros não são recebimentos.
3. No modelo confirmado de saldo negativo, uso = `max(0, -saldo)`;
   crédito restante = `max(0, limite - uso)` quando contrato e conta estão ativos.
   Contrato inativo preserva saldo, uso e versões; crédito adicional é zero.
4. Crédito restante fica fora de receita, projeção de renda, ativos e reserva.
   A posição negativa já reduz a posição bancária e o patrimônio líquido uma vez.
5. Não há taxa presumida nem cobrança automática. Juros e IOF efetivamente
   debitados são despesas reais, com marcador específico na própria transação.
   O uso derivado do saldo inclui esses encargos. O **principal contratual
   segregado não é inferido**: recebimentos podem amortizar encargos e principal
   segundo regras bancárias desconhecidas. Os totais de juros/IOF apresentados
   são débitos registrados, não uma dívida adicional nem encargos ainda devidos.
6. O limite tem versões imutáveis com data de vigência, revisão e motivo/evidência.
   A primeira configuração aceita início retroativo. Mudanças posteriores valem
   de hoje em diante e não antecedem a última versão programada. Várias mudanças
   no mesmo dia preservam auditoria; o histórico usa a última revisão desse dia.
7. Antes da primeira vigência, o saldo histórico é conhecido segundo o livro,
   mas não há limite presumido. O saldo inicial continua com a semântica
   preexistente, sem uma data de abertura inferida ou reescrita.
8. Extrato com representação desconhecida fica **a conciliar**: uso de cheque e
   crédito disponível não são inferidos. O saldo do livro continua explícito.
   Uma representação diferente exige evidências para corrigir/classificar o livro;
   esta entrega não implementa outro modelo de crédito contratual automaticamente.

## Consolidação e patrimônio

`isOperationalAccount` centraliza contas checking/wallet/other e exclui origens
contábeis aposentadas ou vinculadas a investimentos. Contas arquivadas com saldo
continuam contando para não ocultar ativos ou passivos. Crédito de conta arquivada
não aparece como adicional disponível.

- Recursos em contas positivas = soma das posições operacionais maiores que zero.
- Saldos bancários negativos = soma das posições operacionais menores que zero,
  exibida com sinal negativo.
- Posição bancária líquida = soma algébrica das duas parcelas.
- Crédito adicional disponível = limites restantes de contratos ativos confirmados,
  separado dos três indicadores anteriores. Limites a conciliar ficam fora da soma.

Nubank +800 e Itaú -300 resultam em recursos positivos 800, negativos -300,
posição líquida 500. O dinheiro continua localizado nas respectivas contas.

O patrimônio bruto passa a excluir o abatimento das posições operacionais
negativas: ativos bancários positivos + reservas legadas + investimentos.
O patrimônio líquido desconta essas posições negativas, dívidas e faturas
confirmadas pendentes. Não existe um segundo passivo do cheque especial.
Investimentos e suas contas técnicas permanecem excluídos do dinheiro operacional;
reserva é uma classificação dos ativos, não um ativo somado novamente.

A propriedade interna legada `available` / `available_cents` mantém a soma líquida
para compatibilidade com relatórios existentes. Os novos campos `bank`/`banking`
explicitam as quatro parcelas. A Home substitui “Livre no mês” por “Posição prevista
no fim do mês”: o valor é a posição líquida realizada mais os fluxos pendentes,
sem sugerir que compromissos desconhecidos ou juros futuros estejam calculados.

## Uso diário, projeções e conciliação

Carteira → Contas → abrir a conta corrente → Habilitar cheque especial.
Não é preciso recriar a conta Itaú. Limite e início são informados; taxa e notas
são opcionais. A representação do banco começa “a conciliar”, até confirmação
expressa do modelo de saldo negativo. Nenhum percentual é editável.

Novo → Despesa, Receita ou Transferência continua igual. Para juros/IOF, usar
Despesa e a identificação do encargo, na conta corrente que recebeu o débito.
Encargos recorrentes automáticos são bloqueados. Datas reais anteriores à
ativação continuam permitidas e recalculam todas as posições posteriores.

O painel apresenta estado, saldo, limite, uso, crédito restante, histórico por
data, versões e encargos registrados. O histórico é de fechamento das datas com
movimentos ou alterações e da data atual; não inventa ordenação intradiária.
Privacidade mascara dinheiro e percentual. A barra de uso tem tom âmbar, separado
da indicação de recursos próprios. Não há nova aba na navegação inferior.

A projeção geral já parte da posição líquida. -300 + salário previsto de 1.500
resulta em 1.200, sem tornar o salário realizado. O detalhe por conta reutiliza
o mesmo cálculo, considerando somente fluxos vinculados àquela conta e cartões/
dívidas com conta de pagamento explícita. Conta de pagamento desconhecida não é
alocada para prometer recuperação. Mostra o primeiro saldo não negativo previsto
no horizonte preexistente de quatro meses; gastos posteriores podem negativar a
conta novamente. Pendências vencidas são consideradas hoje, com aviso. Sem entradas
suficientes não há data prometida. Limite não utilizado não alimenta a projeção.

“Conferir extrato bancário” tem duas etapas: informar data/saldo/evidência e revisar
a diferença com confirmação explícita. `bank_reconciliations` guarda saldo observado,
saldo calculado, diferença e snapshot dos movimentos e saldo inicial usados. A RPC
calcula esses dados em um único snapshot SQL e rejeita prévia desatualizada.
Não gera lançamento, não modifica saldo inicial e não aproxima operações.
Um lançamento retroativo posterior altera a visão atual, mas preserva a evidência
original da conferência. O painel mostra também o saldo recalculado para aquela data.
A conferência não comprova por si só que uma divergência foi resolvida.

A ação preexistente “Ajustar saldo atual” continua separada, com conferência e
confirmação próprias e ajuste auditável. Para operações conhecidas, deve-se lançar
os fatos reais em Novo, sem trocar receitas/despesas por ajustes genéricos.

## Migration e segurança

`supabase/migrations/202610220016_account_overdraft.sql`:

- Tabelas `account_overdraft_versions` e `bank_reconciliations`, com RLS por usuário,
  chaves compostas de propriedade e escrita direta revogada.
- RPCs `save_account_overdraft` e `record_bank_reconciliation`: autenticação,
  idempotência com os recibos da 014 e validação de propriedade. Configuração usa
  trava da conta e revisão esperada. Alterar tipo/origem técnica de conta com
  histórico de cheque é bloqueado; arquivar não remove dados.
- Coluna opcional `transactions.financial_charge`, sem backfill financeiro;
  valida despesa sem recorrência e a conta corrente correta. A RPC de criação
  mantém as regras e os recibos existentes, acrescentando o marcador.
- Snapshot/exportações incluem contratos, observações e classificações, com leitura
  compatível de snapshots anteriores. JSON inclui a evidência de conciliação;
  CSV/PDF mostram a consolidação e referências, sem efeito financeiro adicional.
- Nenhuma conta existente é configurada automaticamente, e nenhum saldo é alterado.

A regressão concorrente detectou uma corrida da base 015: `now()` representa o início
da transação, anterior a uma espera pela trava do cartão. Fatura manual salva após
uma compra concorrente podia não cobri-la. A 016 usa `clock_timestamp()` para novos
horários de cobertura e para o default de criação de novas compras. O helper de
fatura atualiza a cobertura após a trava. Duas ordens de transações sobrepostas são
verificadas explicitamente; **nenhum timestamp ou registro anterior é atualizado**.

O push desta branch está com deploy desabilitado em `vercel.json`. Não houve merge,
migration remota, acesso ao livro real, publicação na Vercel ou criação de usuários
em serviço remoto. Credenciais injetadas do ambiente não foram usadas nos testes.

## Integração bancária futura

Open Finance/importação poderá alimentar o mesmo livro, mediante uma área de revisão:

1. Guardar lote de origem, instituição, conta, ID externo da operação, hash bruto,
   data de recebimento, data contábil, sinal/valor e saldo observado. Nunca guardar
   credenciais bancárias no livro ou conectar um provedor fictício.
2. Manter um vínculo único `(usuário, origem, conta, ID externo)` e uma chave de
   pedido estável. Duplicatas e correspondências candidatas ficam para revisão;
   igualdade de descrição/valor/data não comprova identidade.
3. O usuário escolhe vincular a um ID existente ou criar a operação confirmada.
   Preservar IDs locais, ponta de transferência e vínculos de cartão, recorrência
   e investimento. Um recebimento bancário nunca vira renda só por ser crédito.
4. Comparar saldo observado com saldo calculado e guardar evidência imutável da
   diferença e da representação de crédito. Exigir confirmação; não alterar saldo
   inicial nem criar ajustes silenciosos. Encargos importados devem ser despesas
   reais únicas, eventualmente vinculadas a operações já registradas.
5. Registrar autoria, revisão, origem e reversões auditáveis. Reutilizar RLS,
   idempotência, validação de proprietário e o snapshot consistente do Rota.

Não há Open Finance, importador ou provedor novo implementado nesta entrega.

## Validação isolada e repetição local

Somente dados sintéticos, em PGlite descartável e PostgreSQL nativo em loopback.
Os navegadores bloqueiam tráfego externo e usam adaptador local ou RPCs reais do
banco descartável. A emulação Chromium não substitui Safari/PWA em iPhone físico.

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

Os scripts de concorrência criam e encerram um cluster local novo; não aceitam uma
URL de banco remoto. O teste de upgrade cria contas/transações na 014, aplica a 015,
cria assinatura sintética e aplica a 016, comparando integralmente os campos
preexistentes do snapshot, IDs e saldo negativo. Testes existentes cobrem também
compatibilidade de ocorrências e pagamentos da 013–015.

Evidências novas: `tests/overdraft.test.ts`, `tests/overdraft-database.test.mjs`,
`tests/overdraft-ui.test.tsx`, fluxos em `scripts/test-mobile.mjs` e disputas em
`scripts/test-financial-concurrency.mjs`. Relatórios/capturas em `test-results/`
(ignorado no Git).

Limitações para revisão local:

- Aplicar 015 e 016 apenas no Supabase local/descartável, na ordem, após a 014.
  O cliente depende das novas tabelas; não distribuir antes da migração aprovada.
- Validar Safari/iPhone instalado, safe areas, teclado decimal e foco dos modais.
- Conferir representação do extrato e a composição de principal/encargos antes
  de registrar fatos reais. O Rota não calcula cobrança contratual definitiva,
  encargos estimados nem uma composição de principal presumida.
- Datas sem movimentos não são materializadas; o histórico mostra os fechamentos
  observáveis. Não há extrato intradiário nem verificação automática no banco.
- Mudança não antecede a última vigência programada; revisar a última versão para
  substituir uma programação futura. Não há edição destrutiva de versões passadas.
- O aviso preexistente de bundle acima de 500 kB continua no build.

## Resultado da validação Cloud

- `npm test`: aprovado — 11 arquivos unitários, 10 de banco e 56 testes de UI.
- Cheque especial: 11 cenários unitários e 7 cenários de banco; upgrade
  014→015→016 comprovado com comparação dos campos preexistentes.
- Concorrência PostgreSQL 17.11 nativo: **25 verificações aprovadas**.
- Navegador com PGlite/RPCs reais e navegação: **76 verificações aprovadas**,
  incluindo cheque especial em 320, 375, 390 e 430 px.
- Experiência existente: **74 verificações aprovadas**.
- Carteira/assinaturas: **41 verificações aprovadas** em 320–430 px.
- Nenhum erro de página ou tráfego externo nos três roteiros de navegador.
- `typecheck`, `lint`, `build` e `git diff --check`: aprovados. O último ajuste de
  histórico foi repetido nos 56 testes de UI e no roteiro de 76 checks mobile;
  o caso de limite zero foi repetido nos unitários. Capturas de 320/375 px foram
  inspecionadas e o histórico mostra os valores monetários corretamente.

Pendente para a validação local: stack Supabase completa (Auth/PostgREST) e
Safari/PWA em iPhone físico. Os testes de RLS usam PostgreSQL com roles e
`auth.uid()` simulada; os navegadores simulam Auth/HTTP sobre o banco isolado.
A integração com um banco real e a composição contratual dos encargos não são
comprovadas nem implementadas automaticamente.

**PRONTO PARA VALIDAÇÃO LOCAL: SIM.**
