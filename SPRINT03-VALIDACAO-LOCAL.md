# Sprint 03 — validação local de implantação

Executada em 14/10/2026, na branch `feat/rota-sprint03-financial-clarity`, a partir de `4f98fcf7503c08ba0ef9f320aa37b54536d41c2b`. Árvore inicial limpa; fetch e pull fast-forward concluídos, sem descarte de alterações. Migrations 001–007 permanecem intactas.

**Resultado: APTO PARA IMPLANTAÇÃO, com as correções locais deste checkpoint.** Esta execução não aplicou migrations remotas, não escreveu registros reais, não reconstruiu a reserva real, não fez merge e não publicou produção.

## Correções de validação

- Migration 009: revogadas permissões de `PUBLIC`, `anon` e `authenticated` na sequência identity `investment_movements_ledger_order_seq`. Os defaults reais do Supabase concedem acesso a sequências novas; o avanço da ordem deve ocorrer pelas RPCs definer.
- Migration 009: revogado também `EXECUTE` de `authenticated` no helper renomeado `investment_value_fixed`. O cálculo interno continua acessível ao owner das RPCs; os clientes usam `investment_value`.
- Regressão de banco reproduz grants automáticos reais para tabelas, funções e sequências e verifica que os helpers legados e a sequência são privados.
- ESLint ignora `test-results`, que contém apenas artefatos gerados/privados. Ferramentas portáteis de validação nesse diretório não devem integrar o lint do código versionado.

## Evidências

- `npm ci`: lockfile respeitado; nenhuma vulnerabilidade reportada.
- `npm test`: 50 testes unitários, 38 testes de banco e 32 de UI passaram. Após a correção da 009, todos os testes de banco foram repetidos: **39 passaram**. Lint passou novamente; typecheck e build passaram. Aviso conhecido: bundle principal acima de 500 kB.
- Chromium local: 77 verificações de experiência e 21 de Sprint 03 em 375/390/430 px; nenhum pageerror ou tráfego externo. Capturas revisadas. Downloads PDF/CSV/JSON validados com dados sintéticos.
- Projeto autenticado e vinculado: **Rota Financeira**, `lgcozsoenycvifiygdsj`, `ACTIVE_HEALTHY`. Destino da configuração pública e dos scripts coincide. PostgreSQL remoto 17.11; PostgREST vinculado 14.18.
- `supabase migration list --linked`: 001–007 aplicadas e correspondentes; somente `202610130008`–`202610130011` pendentes.
- `supabase db push --linked --dry-run`, repetido após a correção: somente 008–011, sem seeds ou roles pendentes. O dry-run lista operações; a execução SQL foi validada separadamente no banco local.
- Dois snapshots frescos de todos os registros financeiros, schema e invariantes foram capturados em transações somente leitura. SHA-256 conferido. Todos os registros, invariantes e histórico de migrations permaneceram iguais entre as capturas. Saldos SQL coincidem com o motor local.
- Backup fresco PostgreSQL em formato custom, com schema e dados de `public`, `auth`, `storage` e `supabase_migrations`, mais roles sem senhas. Arquivo e inventário verificados, SHA-256 registrado. Schemas internos geridos pela plataforma não integram esse backup. Não havia objetos binários em Storage a copiar.
- Snapshots, backups, hashes, scripts de ensaio e logs ficam exclusivamente em `test-results`, ignorado pelo Git, com ACL restrita ao usuário local e SYSTEM. Nenhum valor financeiro, identidade ou credencial integra este relatório.
- RLS remoto, em transação somente leitura: cada identidade com dados financeiros, uma identidade sem dados e `anon` foram exercitadas por impersonação SQL. Cada usuário vê exatamente seus próprios registros; anon não obtém dados. Todas as constraints remotas estão validadas.
- PostgreSQL **17.11 nativo**, restrito a localhost: funções, constraints e políticas de 001–007 comparadas ao snapshot real; replay privado do snapshot fresco e aplicação local de 008–011. Todos os campos preexistentes, FKs/ownership e posições de investimento preservados. Novas tabelas vazias; nenhuma reconstrução automática. Grants das RPCs e isolamento da exportação validados para todos os usuários da cópia.
- PostgREST **14.18 nativo**, restrito a localhost: testes HTTP com fixtures sintéticas. Snapshot devolve 1.101 transações apesar do limite API de 1.000; isolamento A/B/anon; escrita genérica bloqueada; helper privado indisponível; stale preview bloqueado; duas requisições concorrentes e retry produzem uma única substituição. Contas/transações permanecem idênticas e a posição registrada corresponde ao alvo sintético.

## Riscos e limites para a implantação posterior

- ALTER TABLE, validação de constraints e geração da identity podem bloquear temporariamente operações concorrentes. Usar janela breve e monitorar locks; nunca restaurar backup para apagar atividade legítima do usuário.
- A preservação foi comprovada no ensaio com cópia fresca e nas leituras reais desta execução. Após a aplicação futura, repetir snapshot/comparador e invariantes por usuário. Se houver atividade concorrente, investigar diferenças sem presumir que vieram da migration.
- Atualizar/recarregar sessões e PWA antes de permitir a reconstrução manual: clientes antigos não conhecem `replaced_by_id` e podem exibir patrimônio duplicado após uma substituição realizada em outra sessão. A reconstrução real continua sendo ação explícita do usuário, após conferir extratos e diferenças.
- As novas RPCs foram exercitadas em PostgreSQL/PostgREST reais **locais**, pois estão ausentes no remoto por decisão desta execução. Confirmar reload do schema cache na implantação; as migrations notificam `pgrst`.
- CDI/CORS na origem de produção, PWA instalada e downloads em celular físico permanecem verificações posteriores. As estimativas não incluem tributação por lote nem garantem igualdade contratual ao centavo. Sem cobertura CDI, mantém-se a posição registrada; resgates usam essa posição, não a estimativa.
- Regenerar snapshot/backup imediatamente antes da aplicação futura, pois o banco continua em uso. O backup validado cobre os schemas declarados, não uma cópia integral da infraestrutura Supabase.

Sem bloqueio conhecido para aplicar **a versão corrigida** de 008–011. Encerrar esta execução após a validação; implantação, merge e publicação exigem uma execução separada autorizada.
