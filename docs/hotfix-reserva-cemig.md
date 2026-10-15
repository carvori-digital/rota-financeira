# Hotfix Reserva / Cemig — handoff cloud

Base: `main` em `d203c47c50efc5aed26673215f2313912a1c8a47` (Ajuste 04). Branch: `codex/hotfix-reserva-cemig`. Execução em 15/10/2026. Todos os dados utilizados nos testes são sintéticos.

## Causas e correções

1. **Reserva excluída reaparecia.** A migration 012 preserva a conta de origem como `investment_retired`, sem `investment_id`, para manter o histórico bancário. As duas listas de reserva de `PlanningWorkspace` filtravam somente `investment_id`, reapresentando a origem como conta antiga. Agora ambas usam `isLegacyReserveAccount`, excluindo origens aposentadas e migradas. Seletores de pagamento também excluem essas origens; o resumo de patrimônio já tinha essa proteção e recebeu regressão específica. A lista financeira de contas exportadas agora adota o mesmo filtro, preservando as transações históricas no detalhamento e os registros técnicos no snapshot bruto.

2. **Cemig quitada era reaberta pelo valor futuro.** `monthlyCommitments` usava `recurring_items.amount_cents` como obrigação histórica e comparava esse valor ao pagamento antigo. O caso sintético `39678 - 36337 = 3341` reproduz o residual fictício. A migration 013 captura `recurring_occurrences.amount_cents` a partir da transação vinculada, sem alterar essa transação. Na leitura de dados legados sem snapshot, o fallback usa somente a transação vinculada, nunca a regra atual. Referência ausente não comprova pagamento nem permite resolução automática.

   Novas ocorrências capturam seu valor devido. **Ajustar previsão** na lista de recorrentes salva somente a data selecionada, usando uma ocorrência `planned`, sem criar dinheiro. A mudança do valor padrão preserva as previsões já vencidas ou com vencimento hoje pelo valor conhecido da regra anterior; as datas futuras usam o novo padrão, exceto aquelas com previsão própria. A captura ocorre na edição, não inventa versões antigas durante a migration.

   Pagamentos parciais novos preservam o valor devido e cada data/valor efetivamente pago. O primeiro pagamento mantém o vínculo original; complementos têm vínculos em `recurring_payments`, com transações normais no livro bancário. Só o restante real fica projetado. Pagamento integral, tentativas repetidas e ocorrência pulada não lançam valores adicionais. Pagamento parcial efetivo não pode ser simplesmente pulado. A lista de recorrentes também distingue pagamento parcial, integral, pendente e referência ausente.

3. **Marcar pago / Pular causava `undefined ... id`.** O campo `entity` de um compromisso recorrente podia conter o ID da transação, mas `App` procurava uma regra com esse ID e o editor acessava `rule!.id`. Agora `entity` identifica a regra; `transactionId` e `occurrenceId` são vínculos separados. Transação pendente abre sua confirmação existente; previsão e restante parcial usam a regra correta. Registros concluídos não oferecem nova resolução. Referências ausentes e regras pausadas têm proteções e erros legíveis. Os RPCs mantêm idempotência, verificação de usuário e serialização por bloqueio da regra.

4. **Rótulo de transferência/reserva em despesas concluídas.** `impact === 0` era usado como evidência de transferência. Agora o texto depende de `direction === 'transfer'` ou de uma conta de reserva explicitamente identificada. Despesa paga com impacto pendente zero continua sendo despesa realizada.

## Migration nova

`supabase/migrations/202610150013_recurring_occurrence_amounts.sql`:

- Adiciona o snapshot de valor e o estado `planned` às ocorrências.
- Captura valores legados exclusivamente das transações vinculadas; não altera saldos iniciais, transações, datas de pagamento, investimentos ou movimentações existentes.
- Protege o valor de obrigação registrada contra reescrita e preserva previsões vencidas na edição do valor padrão.
- Adiciona `recurring_payments`, com FKs por usuário, RLS e somente leitura direta para `authenticated`; gravação pelo RPC validado.
- Adiciona `set_recurring_occurrence_amount` e `record_recurring_payment`; mantém a assinatura antiga de `resolve_recurring`.
- Inclui os novos vínculos no snapshot de exportação, com a mesma verificação de titularidade.

Migrations 001–012 permanecem intactas. Nenhuma migration foi aplicada remotamente.

## Arquivos

- Cálculos e tipos: `src/features/recurring/{types,calculations}.ts`, `src/features/planning/{types,calculations,commitments}.ts`, `src/utils/finance.ts`.
- Fluxos: `src/App.tsx`, `src/features/planning/{PlanningWorkspace,MonthReport}.tsx`, `src/features/recurring/components.tsx`.
- Exportação: `src/features/export/{calculations,snapshot}.ts`.
- Banco: migration 013 indicada acima.
- Regressões: `tests/hotfix.test.ts`, `tests/hotfix-database.test.mjs`, `tests/hotfix-ui.test.tsx`; fixture de obrigação explícita em `tests/commitments.test.ts`; integração da ação canônica e nova tabela no mock em `tests/ui.test.tsx`.
- Execução: `package.json`, `vitest.config.ts`, `scripts/test-mobile.mjs`.
- Handoff: `docs/hotfix-reserva-cemig.md`.
- Publicação: `vercel.json` desabilita deployments Git desta branch específica. Nenhum comando de deploy ou merge é executado.

## Verificações cloud

Todos os grupos abaixo passaram em suas execuções finais. Os testes não usam Supabase de produção. PGlite executa o PostgreSQL descartável com migrations, papéis `authenticated`/`anon`, RLS e usuários sintéticos A/B. O navegador usa Auth/HTTP simulados, RPCs reais nesse banco descartável e bloqueio de qualquer saída externa.

- Regressões unitárias: outubro quitado, novembro previsto, valor variável, alteração de padrão, ausência do residual fictício, parcial/integral, identidade canônica, arquivamento, cancelamento, referências ausentes, patrimônio, Caixinha e exportação.
- Regressões de banco: preservação de transações/contas pela migration; imutabilidade do snapshot; previsão por data; regra arquivada; pagamento parcial/complemento; requisições repetidas ou incompatíveis; pular sem movimentação; permissões, FKs e RLS A/B; snapshot de exportação.
- Regressões de interface: reserva aposentada ausente na lista e no seletor, Caixinha preservada, rótulos pela natureza, referência ausente nas duas ações, IDs canônicos, data/valor pagos, retry e previsão mensal.
- Navegador: 375/390/430 px, fluxos anteriores e cenários específicos de Cemig quitada, pagamento parcial/restante, pular ocorrência, ajustar previsão, reserva aposentada e Caixinha.

## Limitações e validação local

- Não houve leitura nem escrita nos dados financeiros de produção; valores do relato serviram somente de fixtures. Portanto não se afirma que a situação real da conta foi auditada.
- Ocorrências antigas sem valor devido capturado não permitem reconstruir uma eventual parcela pendente antiga. A migration preserva o valor comprovado pela transação vinculada; não supõe que a diferença para a regra atual seja dívida. Se houver comprovação externa de um parcial antigo, precisa de conferência manual separada.
- PGlite não substitui a validação de Auth/PostgREST hospedados nem a concorrência de múltiplas conexões PostgreSQL. As proteções de replay e atomicidade são exercitadas no banco isolado; os bloqueios da regra precisam de ensaio concorrente no PostgreSQL local antes da implantação.
- Chromium nas três larguras não substitui Safari/WebKit físico, teclado iOS ou atualização de PWA instalada.
- CDI usa as rotinas existentes e seus testes; não foram consultadas taxas externas ou saldos reais.
- O script nativo anterior `test-adjust04-native.mjs` usa executáveis Windows e snapshot privado opcional; ele não é requisito para os testes sintéticos desta execução e não foi usado na nuvem.

## Procedimento seguro para conferência e futura implantação

1. Buscar a branch e conferir commit/diff. Manter a branch sem merge e com deploy Git desabilitado. Fazer backup local antes de qualquer ensaio que use cópia privada; não adicionar backups, credenciais ou dados reais ao Git.
2. Reproduzir `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` e `BROWSER_EXECUTABLE=/caminho/do/chromium npm run test:mobile` com variáveis de teste. `test:live`, scripts remotos e `db reset` não fazem parte desse procedimento.
3. Em uma instância PostgreSQL/Supabase **descartável e local**, aplicar as migrations em ordem, com `ON_ERROR_STOP`, e inserir somente fixtures sintéticas. Conferir a 013 antes de executá-la. Não apontar comandos de ensaio para o projeto Supabase de produção.
4. Conferir contagens/fingerprints e saldos antes/depois da 013; validar RLS com duas sessões, chamadas RPC pelo PostgREST e duas conexões concorrentes resolvendo a mesma ocorrência.
5. No iPhone, conferir: Reserva antiga ausente; Caixinha preservada; outubro quitado pelo valor e data registrados; novembro em R$ 396,78 por Ajustar previsão; contador da Home e relatório consistentes; pagar/pular sem exceção; parcial e complemento uma única vez; CSV/JSON/PDF sem duplicidade; PWA recebendo a versão correta.
6. A aplicação nova exige o schema 013 para carregar `recurring_payments`. Os novos estados `planned` exigem o frontend novo. Planejar a atualização de banco/frontend em conjunto, com janela controlada, apenas em uma etapa de implantação explicitamente autorizada. Um rollback de frontend antigo após uso de previsões `planned` exige revisão de compatibilidade; não apagar ocorrências/transações para contornar isso.
7. Após autorização específica e validação local, o responsável pode planejar aplicação remota da 013 e publicação. Esta entrega não faz essas ações nem altera o bloqueio de deploy da branch.

## Resultado final

- `npm run test:unit`: **9 módulos passaram**, incluindo as sete novas regressões de cálculo, exportação/patrimônio e as suítes de CDI/PWA.
- `npm run test:db`: **7 módulos passaram**, com migrations, RLS, integridade, histórico e a nova suíte 013. Esta também passou diretamente com seus sete subcasos (oito resultados contando o agrupamento).
- `npm run test:ui`: **47 testes passaram em 4 arquivos**, incluindo a integração de `App` com o vínculo canônico e oito casos de interface do hotfix.
- `BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:mobile`: **70 verificações passaram**, incluindo 15 específicas do hotfix nas três larguras; `errors: []`, `outbound: []`.
- `npm run typecheck`, `npm run lint`, `npm run build`, verificação de formatação e `git diff --check`: **passaram**. O build mantém o aviso de bundle maior que 500 kB, sem erro.
- As 12 migrations anteriores foram comparadas aos blobs da base Git e estão **intactas**.
- Evidências locais não versionadas: `test-results/mobile/report.json` e capturas `375-hotfix-reserva-cemig.png`, `390-hotfix-reserva-cemig.png`, `430-hotfix-reserva-cemig.png` na mesma pasta.
- Dados de produção: **não acessados nem modificados**. Sem migrations remotas, merge ou comando de deploy.
- O commit desta entrega é o HEAD da branch indicada; conferir por `git log -1 codex/hotfix-reserva-cemig` após o fetch. O hash e o resultado do push são informados na entrega da conversa.

**PRONTO PARA VALIDAÇÃO LOCAL: SIM.** Permanecem os ensaios de Safari/PWA real, Auth/PostgREST e concorrência PostgreSQL local descritos acima; a implantação de produção não faz parte desta entrega.
