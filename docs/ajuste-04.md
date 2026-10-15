# Rota Financeira — Ajuste 04

Branch: `codex/ajuste-04-investimentos`. Migration incremental: `202610140012_simple_investments.sql`.

## Diagnóstico e decisões

- A migration 005 espelhava saldos e transações de contas antigas em `investment_movements`. A conta convertida fica inativa e vinculada por `investment_id`, mas as transferências continuam sendo o razão bancário legítimo. Apagar essas transferências devolveria dinheiro indevidamente às contas operacionais.
- A migration 007 e `DeleteRecord` bloqueavam investimentos com `source_account_id`. A exclusão antiga de investimentos comuns desfazia transações; essa operação permanece para compatibilidade, mas a tela de investimentos agora usa a exclusão que preserva o razão bancário.
- `Investments` desabilitava resgate para investimentos arquivados ou sem valor estimado positivo. O novo fluxo explica arquivamento, apresenta a posição registrada separada da estimativa e oferece sincronização. Um investimento arquivado pode ser reativado em Editar; sua exclusão não exige reativação.
- As migrations 009 e 010 introduziram âncoras CDI, ordem contábil, vigências e reconstruções com FKs. A 012 reutiliza esses registros e o motor CDI existente. Nenhuma migration anterior é alterada.

## Comportamento

**Excluir investimento:** pede o nome e a confirmação explícita. A posição sai dos totais/reserva; nenhuma transação bancária é apagada ou estornada. Movimentos técnicos e taxas ficam preservados no registro privado de auditoria da exclusão e são removidos das tabelas ativas. A conta convertida é mantida inativa como origem contábil (`investment_retired`), sem participar dos totais e sem permitir reativação ou edição de seu histórico. Se reconstruções anteriores exigirem a FK, permanece somente o cadastro com `deleted_at`, oculto da interface, patrimônio e lista de investimentos nos relatórios. Não há exclusão automática no deploy.

**Cadastro:** nome, instituição, produto, data inicial, modelo/taxa, reserva e saldo inicial opcional. A posição inicial é uma âncora datada, sem receita/despesa ou débito bancário. O usuário confirma que o mesmo dinheiro não está representado em outra conta/investimento. CDI de 115% é uma condição informada pelo usuário, não uma elegibilidade presumida.

**Aporte/resgate:** os mesmos componentes atendem Investimentos e Novo. Conta operacional e posição são atualizadas atomicamente; transações de ajuste não são receitas, despesas ou compromissos. A posição confirmada, para todos os modelos, limita resgates; estimativas não liberam dinheiro. As requisições têm UUID, validação integral do payload e serialização por usuário. A prévia confere posição, data, valor e efeito na conta; posição alterada durante a confirmação bloqueia a operação.

**Histórico/correções:** posição inicial, aportes, resgates, sincronizações, contas relacionadas, datas e descrições ficam visíveis. Estorno de caixa cria a operação inversa, preserva o original e verifica saldo. Sincronização só pode ser estornada sem movimentos posteriores. Posições iniciais/importadas e transferências preservadas são corrigidas pela reconciliação, evitando apagar o razão.

**Reconciliação:** saldo de conta registrado, histórico considerado, saldo real, diferença e efeito são exibidos antes da confirmação. Lançamentos faltantes devem ser registrados com seu tipo próprio. Transferências comuns podem ser vinculadas sem novo crédito/débito quando a outra ponta é a origem inativa deste investimento ou uma origem aposentada. Valor, data, sentido, usuário e ausência de vínculo anterior são conferidos. Transferências entre duas contas operacionais não são convertidas automaticamente: é necessária revisão da classificação das contas. Movimentos semelhantes exigem conferência; para confirmar que uma transferência semelhante é distinta, a descrição deve começar por `Conferido:`.

Datas passadas são aceitas desde o início da posição, desde que não antecedam uma sincronização posterior nem deixem posições posteriores negativas. Uma âncora posterior já representa esse período; lançar caixa antes dela sem revisão poderia duplicar o saldo. Nenhum histórico é inferido ou preenchido.

## Verificação e recuperação

- Testes unitários: financeiro, compromissos, CDI, patrimônio, exportação e PWA.
- PGlite: migrations, conservação do patrimônio, exclusão física e com reconstrução, transações preservadas, saldo inicial, resgate histórico, estorno, reconciliação, retries e RLS A/B/anon.
- Interface: cadastro, exclusão confirmada, prévia, resposta perdida, resgate sem saldo, orientação sem investimento e reconciliação de conta.
- Mobile isolado: PostgreSQL em memória com RLS e HTTP/Auth simulados; 375/390/430px, teclado numérico, datas, aportes/resgates, exclusão e prévias. Nenhuma requisição externa.
- PostgreSQL 17/PostgREST 14 nativos: snapshot fresco restaurado somente em localhost; comparação de funções/constraints e de todos os campos preexistentes; criação/aporte/exclusão concorrentes, resgates concorrentes distintos, RLS e grants. `scripts/test-adjust04-native.mjs` aceita o snapshot privado como argumento e exige os binários locais indicados por `PG_TEST_BIN`/`POSTGREST_TEST_BIN`.

Backup lógico fresco de public/auth/storage metadata/migrations e roles sem senhas, hash verificado e arquivo integralmente legível. Todos os registros financeiros atuais foram comparados com o backup. Storage estava sem objetos binários. Arquivos de backup, snapshots, configurações e relatórios com dados privados ficam somente no diretório ignorado `test-results`.

Antes da implantação: confirmar projeto `lgcozsoenycvifiygdsj`, snapshot imediato, cobertura do backup, dry-run contendo somente 012 e checks aprovados. Depois: novo snapshot, comparação de todos os registros e invariantes por usuário, auditoria somente leitura de FKs/RLS/RPCs, Vercel READY e commit servido em release.json/SW. Não restaurar snapshots antigos sobre produção; qualquer correção posterior exige análise e migration incremental. Testes de mutação ficam exclusivamente em ambientes isolados.

## Limites

O motor CDI, cache/offline, fonte BCB e limitações fiscais do Sprint 03 permanecem. A validação mobile usa Chromium com dimensões e toque de iPhone; não equivale a um teste físico de Safari/iOS. Exclusão de cadastro não constitui resgate e não aumenta saldo bancário. Nenhuma reserva, Caixinha, aporte ou resgate real é executado pelo processo de publicação.
