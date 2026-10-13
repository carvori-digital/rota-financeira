# Sprint 03 — checkpoint Cloud

Base sincronizada: c60c5141a98b21a486b22e0b7977cea0f7b5c230.
Branch: feat/rota-sprint03-financial-clarity. Estado inicial limpo; branch `work` preservada.

Limites: nenhuma migration remota, dado real, merge, deploy, snapshot/reset ou reconstrução real. Fixtures locais somente.

Em andamento: modelo compartilhado de obrigações mensais. `planning_group` tem default e não prova agendamento histórico. Conclusão de programadas exige marcador explícito; migration incremental preservará evidência de vencimento ao confirmar. Parcelas históricas sem valor integral confiável não serão inferidas.

Próximos passos: testes do modelo; CDI com fonte SGS 12 e cobertura verificável; reconstrução transacional; exportação; validação e handoff.

Checkpoint 2: CDI pesquisado/documentado; motor diário com aportes próprios, resgates, vigências e âncora de sincronização; cache BCB explícito. Tests unitários e typecheck passam. Migrations 008/009 ensaiadas em PGlite junto às existentes; nenhum acesso ao banco remoto. Reconstrução/exportações ainda em andamento.

Checkpoint 3: reconstrução preparada em migration 010 e interface de duas etapas. PGlite validou atomicidade, retry idempotente, rejeição de revisão desatualizada, integridade das transações/contas, posição histórica sem débito, bloqueio de reativação/exclusão e isolamento A/B. Nenhuma reserva real foi reconstruída. Exportação ainda em andamento.

Checkpoint 4: exportação PDF/CSV/JSON e prévia prontas; snapshot consistente por RPC invoker com RLS, contagens verificadas e whitelists sem autenticação. Mês completo depende de confirmação explícita; setembro não confirmado permanece parcial. Testes locais com >1000 linhas, arquivos e isolamento passaram. Mobile: 77 verificações da experiência existente e 21 específicas de exportação/reconciliação, em 375/390/430px, sem chamadas externas.

Revisão identificou e corrigiu ordenação de sincronizações/aportes no mesmo dia: migration 009 adiciona `ledger_order` imutável por identity (somente metadado novo; nenhuma informação financeira anterior alterada). Teste de regressão adicionado. Ensaio estrutural compara todos os campos preexistentes antes/depois.

Próximos passos: concluir validação geral após ajustes visuais, handoff, revisão final e push apenas da branch.
