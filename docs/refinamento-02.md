# Refinamento 02 — gestão de registros

Implementação: `20bd537`, branch `feat/rota-record-management-02`.

## Comportamento

- Compras sem pagamentos relacionados podem ser excluídas definitivamente, incluindo parcelas, auditorias, ajustes e revisões exclusivamente vinculados. Faturas informadas que cobriam a compra são recalculadas. Compras pagas continuam protegidas e usam ajuste rastreável.
- Metas, inclusive a configuração da reserva, podem ser excluídas com seus aportes e vínculos. Contas, transações e investimentos permanecem.
- Investimentos manuais podem ser excluídos com seus movimentos e exatamente as transações operacionais de aporte/resgate vinculadas. Investimentos migrados são bloqueados.
- Cartões sem compras/faturas/pagamentos, dívidas sem pagamentos e recorrências sem ocorrências ganharam exclusão. Programados continuam com exclusão no extrato.
- As ações ficam em detalhes secundários e exigem confirmação. O backend revalida propriedade e dependências, mesmo com uma tela desatualizada.

## Validação em 05/10/2026

- 35 testes unitários, 31 testes de banco (incluindo agrupadores) e 29 testes de UI passaram. O worker de UI teve timeout de inicialização; a repetição isolada passou.
- Typecheck, lint e build passaram. O build conserva o aviso de bundle acima de 500 kB.
- Mobile/experience: 77 verificações em 375/390/430 px, sem erros ou tráfego externo, com ações secundárias expandidas.
- Migration `202610050007_record_management.sql`: somente criação de capacidade e ajuste de permissão; nenhuma instrução de alteração de dados fora das funções.
- Snapshot fresco privado: `test-results/consolidation-current-2026-10-05-1791235117095.json`, acompanhado de SHA-256. Não versionado.
- Ensaio sobre esse snapshot em PostgreSQL em memória preservou registros, FKs, cascatas e policies; validou permissões das quatro RPCs.
- Dry-run remoto confirmou somente a 007 pendente. Aplicação incremental concluída sem reset ou restauração.
- Snapshot posterior: `test-results/consolidation-current-2026-10-05-1791235190858.json`, privado e não versionado.
- Comparação exata: 67 registros em 19 tabelas preservados, incluindo IDs, valores e demais campos. Saldos de contas, faturas, investimentos, reserva e patrimônio preservados.
- Introspecção remota: quatro funções `security definer`, `search_path` vazio, execução por `authenticated`, sem execução por `anon`/`public`; RLS preservado.
- Nenhum registro fictício foi criado em produção; nenhuma exclusão real foi executada.

## Limites deliberados

Exclusões que tornariam uma fatura informada incompatível com a compra/ajustes são bloqueadas integralmente. Investimentos com origem migrada ou vínculos operacionais inesperados também são bloqueados. Os registros financeiros liquidados continuam protegidos.
