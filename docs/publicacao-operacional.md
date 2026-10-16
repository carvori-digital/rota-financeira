# Liberação operacional — 16/10/2026

**Preparação crítica aprovada. Produção ainda não alterada.** Falta confirmação do usuário antes da primeira mudança no banco.

- Produção confirmada: `main d203c47`, Vercel `READY`, domínio `rota-financeira-delta.vercel.app`.
- Supabase confirmado: projeto `lgcozsoenycvifiygdsj`, PostgreSQL 17.11, migrations 001–012. Dry-run planeja exclusivamente 013 e 014.
- Trabalho local anterior preservado em `test-results/release-preserved/`; evidências originais e fingerprints continuam válidos. Nenhuma mudança adicional na aplicação ou nas migrations.

## Verificações críticas

| Verificação                                    | Resultado                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Regressão já aprovada e preservada             | 67/67 cálculo, 75/75 banco, 47/47 UI; 11/11 concorrência; 70 mobile                                                                              |
| Auth → PostgREST → PostgreSQL reais, localhost | **12/12**: login A/B, RLS, cache de schema, CRUD/auditoria, retry HTTP, recorrências, dívidas, investimentos, permissões, JWT expirado e refresh |
| Cópia dos dados reais → 013 → 014              | **Passou**: todos os registros financeiros, vínculos, saldos e patrimônio preservados                                                            |
| Backup financeiro                              | **Concluído**: todas as 23 tabelas financeiras públicas e metadados; SHA-256 e restauração local verificados                                     |
| Plano remoto de migrations                     | Apenas `202610150013` e `202610150014`; nenhuma aplicada                                                                                         |
| PWA/iOS automatizado disponível                | Manifest/ícones/configuração iOS e ausência de cache financeiro já passaram; Chrome mobile já passou; WebKit não instalado                       |

Evidências privadas: `test-results/release/integration.json`, `test-results/release/backup-restore.log`, `test-results/release/migrations-dry-run.log` e o manifesto `.release-verified.json` junto ao backup. Dados financeiros e credenciais permanecem fora do Git.

O Auth usa fonte oficial `supabase/auth v2.197.0`, com uma adaptação local exclusivamente no listener TCP: remoção da opção Unix `SO_REUSEPORT` para compilar no Windows. Código de autenticação, JWT, sessão, banco e permissões permanece igual. PostgREST e PostgreSQL são nativos; não há mock de Auth/HTTP nesses 12 testes. Falhas intermediárias de configuração do laboratório foram corrigidas; não representam alterações financeiras da aplicação.

O backup é financeiro, não um backup completo de Auth/storage/plataforma. Essas camadas não serão alteradas por 013/014. A restauração testada ocorreu exclusivamente em banco descartável; não há plano de sobrescrever dados recentes em produção.

## Legados: preservar sem bloquear os demais módulos

As cinco ocorrências e oito pagamentos antigos foram preservados integralmente no ensaio com dados reais. A migration não inventa obrigações ou alocações antigas. Não há FK incompatível, transação vinculada ausente ou parcela atual inconsistente nos critérios examinados. Uma recorrência paga tem valor menor que a regra atual; isso pode ser valor variável ou parcial e não autoriza inferir diferença. Sua conferência histórica é pontual, sem reparo automático e sem bloquear as demais operações. A receita futura pendente permanece pendente até ação explícita.

## Execução após confirmação

1. Fechar as abas/PWA antigas durante a janela curta de manutenção. Ativar a página temporária de manutenção preparada, sem operações financeiras disponíveis.
2. Revalidar projeto, schema, fingerprints e backup contra o estado corrente. Se houver dados novos desde o backup, capturar e verificar nova cópia; não restaurar dados antigos sobre recentes.
3. Aplicar 013 e 014 em ordem. Validar ledger, saldos iniciais, estado das dívidas, FKs, grants, RLS e exposição das RPCs. Nenhum lançamento fictício em produção.
4. Publicar o commit candidato correspondente em `main`/Vercel. Confirmar `READY`, `release.json`, bundle e service worker do mesmo commit antes de encerrar a manutenção.
5. Verificar carregamento/login e consultar saldos/histórico existentes. Login real depende da sessão/credenciais do usuário; não declarar login real validado apenas com mock.

**Recuperação não destrutiva:** se o banco não mudou, retornar ao deploy anterior. Se 013/014 já foram aplicadas, manter manutenção e corrigir adiante; não remover tabelas de evidência, reabilitar rotas revogadas, executar reset ou restaurar snapshot antigo. Se a integridade divergir, parar antes de liberar operações.

## iPhone real — roteiro de 2 minutos após publicação

1. Fechar e reabrir o Safari e a PWA; entrar e conferir a versão em Ajustes.
2. Comparar saldos e histórico conhecidos; conferir recorrências, dívidas e reserva/investimentos.
3. Abrir formulários de receita/despesa, pagamento e aporte/resgate; verificar teclado, datas e botões. Fechar sem salvar se não houver operação real desejada.
4. Em uma operação real desejada, salvar uma vez e confirmar um único efeito no saldo e histórico. Comunicar qualquer divergência antes de repetir.

Teste físico de iPhone **não executado**. Não é necessário criar movimentações de teste em produção.
