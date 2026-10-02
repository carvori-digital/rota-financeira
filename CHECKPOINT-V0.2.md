# Checkpoint local V0.2 — 01/10/2026

Base retomada: `b6c916e` (`WIP checkpoint: implementacao parcial Rota Financeira V0.2`). O Git estava limpo na retomada. As alterações finais estão salvas em disco, sem novo commit, push ou deploy.

## Funcional e validado localmente

- Home com livre no mês, saldo realizado, compromissos/receitas restantes, faturas, dívidas, reserva, patrimônio, próximos compromissos e quatro meses de projeção.
- Planejar: Projeção, Cartões, Dívidas, Recorrentes e Investimentos/Reserva.
- Novo: Receita, Despesa, Transferência, Compra no cartão, Pagamento de dívida e Aporte/transferência; conta lembrada durante a sessão.
- Formulários de criação/edição, compra parcelada, fatura manual, pagamentos parciais, realização/pulo de recorrências e configuração da reserva.
- Realizado, Previsto, Pendente e Pulada identificados por texto e cor. Rótulos acessíveis de selects corrigidos.
- Motor original preservado e coberto por regressões de centavos, datas, parcelas, limites de dívida, transações futuras, recorrências resolvidas e ausência de dupla contagem.

## Banco

As migrations `202610010001_initial.sql` e `202610010002_planning.sql` não foram alteradas. Aplicar futuramente apenas 002 e `202610010003_planning_integrity.sql`, nessa ordem, sobre a V0.1 existente. A 003 adiciona integridade de parcelas de dívida, protege compras contra exclusão e mantém cobertura de fatura estável em repetição de requisição. Permite definir calendário de dívida antes do primeiro pagamento.

Validação incremental em PGlite/PostgreSQL: dados V0.1 criados antes de aplicar 002+003 e conferidos campo a campo; RLS nas nove tabelas A↔B, FKs, permissões, RPCs, integridade, atomicidade e idempotência verificadas. Sem reset. Nenhuma migration remota aplicada.

## Resultado final

- `npm test`: 48 passaram (20 cálculos/PWA, 8 banco, 20 interface), zero falhas.
- `npm run typecheck`, `npm run lint`, `npm run build`: concluídos com sucesso. Build tem apenas aviso de tamanho de bundle, sem erro.
- `npm run test:mobile`: 26 verificações passaram em Chrome headless, larguras 375/390/430 px; sem overflow horizontal, erro de JavaScript ou pedido de rede externa. Formulários executados sobre PostgreSQL migrado com RLS; Auth e HTTP simulados.
- Logs finais em `test-results/validation/`; capturas e relatório em `test-results/mobile/` (ignorados pelo Git).

O teste de modal do checkpoint falhava antes de abrir o modal porque o mock não incluía as tabelas de planejamento. O cenário isolado passou após corrigir as fixtures. Foram acrescentadas regressões de fechamento normal e com movimento reduzido. A rodada concorrente final teve timeouts por carga; a rodada sequencial final passou completa.

## Limite da validação e próxima etapa

Integração V0.2 com Auth/PostgREST do Supabase real ainda não validada: migrations remotas continuam pendentes por instrução do usuário. Produção e dados reais intactos. Próxima etapa: validar o pacote e migrations em Supabase de homologação antes de autorizar publicação.

## Fechamento do produto — 02/10/2026

O pedido posterior autorizou migrations remotas, commit, push para main e publicação. Os limites de não publicar do checkpoint anterior foram substituídos por essa autorização.

Implementados status explícito, programadas/encargos, relatório único com composição de compromissos, numeração e término de parcelas, ajuste de saldo rastreável e configuração rápida em sete etapas. Os módulos originais foram integrados. Movimentos mostra realizado; Planejar tem seis áreas internas e Novo oito ações.

Validação final: 60 testes (27 cálculo/PWA, 11 banco, 22 UI), typecheck, lint e build aprovados; 30 verificações mobile com 23 fluxos e larguras 375/390/430. O modal original foi corrigido após confirmar que as fixtures não incluíam tabelas de planejamento.

002+003+004 foram ensaiadas no remoto com rollback e depois aplicadas incrementalmente. Fingerprints confirmaram preservação dos registros e do usuário preexistentes. Auth/PostgREST e RLS reais passaram com QA isolado; os registros financeiros de teste foram limpos, mantendo os usuários QA. Nenhum usuário ou registro real foi apagado.

A versão publicada pode ser identificada em /release.json, Ajustes e no worker. A conferência da produção e da atualização de uma PWA anterior fica em test-results/production-validation.json; logs e capturas não são versionados.
