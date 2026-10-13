# Sprint 03 — checkpoint Cloud

Base sincronizada: c60c5141a98b21a486b22e0b7977cea0f7b5c230.
Branch: feat/rota-sprint03-financial-clarity. Estado inicial limpo; branch `work` preservada.

Limites: nenhuma migration remota, dado real, merge, deploy, snapshot/reset ou reconstrução real. Fixtures locais somente.

Em andamento: modelo compartilhado de obrigações mensais. `planning_group` tem default e não prova agendamento histórico. Conclusão de programadas exige marcador explícito; migration incremental preservará evidência de vencimento ao confirmar. Parcelas históricas sem valor integral confiável não serão inferidas.

Próximos passos: testes do modelo; CDI com fonte SGS 12 e cobertura verificável; reconstrução transacional; exportação; validação e handoff.

Checkpoint 2: CDI pesquisado/documentado; motor diário com aportes próprios, resgates, vigências e âncora de sincronização; cache BCB explícito. Tests unitários e typecheck passam. Migrations 008/009 ensaiadas em PGlite junto às existentes; nenhum acesso ao banco remoto. Reconstrução/exportações ainda em andamento.
