# Rota Financeira — continuação da auditoria local

**Atualização de 16/10/2026:** os bloqueios operacionais de integração e backup foram resolvidos na missão de liberação. Ver [publicacao-operacional.md](publicacao-operacional.md). Este documento preserva o estado da continuação anterior.

15/10/2026 · base `62d69ac` · branch `codex/auditoria-estrutural-financeira`

**PUBLICAÇÃO AINDA NÃO APROVADA.** A regressão local está verde. Permanecem bloqueios de integração, dados históricos e plataforma. O hotfix 013 isolado continua insuficiente.

## Estado e preservação

O checkout começou limpo em `main d203c47`, sem alterações rastreadas ou arquivos não rastreados a preservar. Foram feitos fetch de `origin` e checkout da branch remota no commit solicitado. `.env.local`, dependências e demais arquivos ignorados foram preservados. As alterações desta continuação permanecem locais, sem commit ou push.

Nenhuma transação, saldo, configuração financeira ou migration remota foi alterada. Não houve merge ou deploy. As únicas operações no projeto Supabase vinculado foram consultas de metadados e contagens dentro de transações `READ ONLY`, com timeout de 15 segundos e rollback. Não foram exportados nomes, identidades ou valores individuais.

## Resultados atuais

| Pendência/verificação                          | Resultado                                                                                                                              | Evidência local em `test-results/audit/`                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Regressão global final                         | **67/67 cálculo, 75/75 banco, 47/47 UI**; nenhum skip ou falha                                                                         | `local-global-final.log`                                                                                                               |
| Estabilidade do antigo caso UI 46/47           | **Cinco execuções completas 47/47**, duas delas dentro de `npm test`; mesmos prazos, asserções e perfil threads/um worker              | `../audit-local-ui-unrestricted.log`, `local-global-1.log`, `local-ui-repeat-1.log`, `local-ui-repeat-2.log`, `local-global-final.log` |
| PostgreSQL nativo e concorrência               | **11/11**, PostgreSQL 17.10 Windows; cluster descartável em `127.0.0.1`, encerrado ao final                                            | `local-concurrency.log`, `concurrency.json`                                                                                            |
| Compatibilidade 013 + 014                      | Passou preservação do livro bancário, saldo inicial, identidade e competência; 014 preserva todos os campos anteriores das ocorrências | `local-global-final.log`                                                                                                               |
| Upgrade de receita futura legada               | **012→013→014 passou**: continua pendente sem caixa; confirmação/retry produz uma única entrada, cancelamento não movimenta dinheiro   | `local-global-final.log`                                                                                                               |
| Diagnóstico compatível com schemas 012/013/014 | Três cenários sintéticos passaram, com `read_only=on` e preservação integral das transações                                            | `local-global-final.log`                                                                                                               |
| Mobile Chrome 375/390/430 px                   | **70 verificações**, `errors=[]`, `outbound=[]`, em execução separada                                                                  | `local-mobile-serial.log`, `../mobile/report.json`                                                                                     |
| Typecheck, lint, build e whitespace            | Passaram; build mantém aviso de bundle acima de 500 kB                                                                                 | `local-typecheck.log`, `local-lint-final.log`, `local-build.log`                                                                       |
| Integridade das migrations                     | SHA-256 de **001–014 idênticos** às evidências de `62d69ac`                                                                            | `docs/evidencias-auditoria-estrutural.json`                                                                                            |

O timeout original de feedback não foi reproduzido nas cinco execuções completas verdes; não foi inventada uma correção financeira ou alterado o teste para fazê-lo passar. Isso demonstra estabilidade nas execuções locais registradas, sem provar estabilidade em toda máquina/CI. Tentativas restritas pelo sandbox falharam no `realpath` do Vite antes de executar os testes; as execuções válidas usaram o checkout original fora dessa restrição.

O primeiro ensaio mobile teve timeout ao clicar em “Ocorrências realizadas e puladas”, durante execução junto com outros testes. A execução separada passou com os mesmos prazos e asserções. Esse timeout fica registrado em `local-mobile.log`, sem atribuir causa definitiva ou declará-lo um defeito financeiro. Preferir execução sequencial dos ensaios de navegador e banco nativo.

O teste novo de upgrade inicialmente exigia preservação de `updated_at` também na 013. A 013 existente faz backfill de `amount_cents` passando pelo trigger que atualiza esse timestamp; a expectativa foi ajustada para essa mudança de metadado conhecida, mantendo preservação de todos os fatos financeiros. Na 014, todos os campos anteriores, inclusive `updated_at`, continuam sob comparação integral. Nenhuma migration foi editada.

## Diagnóstico remoto somente leitura

O projeto já vinculado contém migrations **001–012**, PostgreSQL **17.11**; 013 e 014 não foram aplicadas. O inventário agregado contém 58 transações, cinco regras/ocorrências recorrentes, oito pagamentos de dívida e dois pagamentos de cartão. Logs: `local-legacy-schema.log` e `local-legacy-counts.log`.

| Sinal                                                                                                      |        Contagem | Interpretação                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | --------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ocorrências sem valor originalmente capturado                                                              |               5 | Esperado para schema anterior à 013; o pagamento não comprova sozinho o devido original, especialmente se parcial.                                                                        |
| Ocorrências sem termos congelados                                                                          |               5 | Schema anterior à 014; configuração atual não comprova versões antigas.                                                                                                                   |
| Pagamentos de dívida sem obrigação original capturada                                                      |               8 | Não é possível certificar alocação por competência ou ausência de antecipações apenas com esse campo.                                                                                     |
| Ocorrência registrada sem transação realizada correspondente                                               |               1 | Transação presente, `income`, `pending`, competência e data de caixa futuras: compatível com agendamento legado, sem prova de corrupção. O upgrade sintético cobre essa classe de estado. |
| Pagamentos de dívida/cartão sem movimento correspondente                                                   |           0 / 0 | Nenhuma divergência nos critérios verificados de tipo, status, valor e data.                                                                                                              |
| Divergência regra/fato, FK de termos incompatível, competência planejada fora do calendário, compra futura | 0 em cada sinal | Ausência de sinais nesta leitura; não é certificação de todo o histórico.                                                                                                                 |
| Antecipações agregadas detectáveis pelo valor original                                                     |               0 | Resultado inconclusivo para os oito pagamentos sem valor original; não prova ausência de antecipações.                                                                                    |

Os grupos de cinco ocorrências se sobrepõem; não representam dez problemas distintos. Os sinais não determinam automaticamente correções. Para certificar o histórico, conferir comprovantes/contratos e definir conciliação auditável sem substituir fatos pela configuração atual.

## Alterações locais

- Corrigido o executor PostgreSQL: `pg_ctl -o` recebia um caminho com espaços sem aspas, falhando antes dos cenários. No Windows, o ensaio usa TCP local sem socket Unix; no Linux, o caminho do socket fica entre aspas. Os 11 cenários passaram após a correção.
- Acrescentados diagnósticos SQL somente leitura: metadados e contagens compatíveis com o schema remoto anterior à 013.
- Acrescentados quatro cenários de banco: diagnóstico em 012/013/014 e upgrade de receitas futuras legadas. Não houve mudança de comportamento na aplicação ou nas migrations.
- Atualizados relatório canônico e evidências; a verificação original foi preservada como histórico no JSON.

## Bloqueios e condições para publicação

1. **Auth → PostgREST → RPC isolados: pendente.** Docker está instalado sem daemon ativo; WSL não está instalado. Não há URL/credenciais de backend isolado nem usuários A/B de teste configurados. As credenciais públicas locais apontam para o projeto vinculado, usado exclusivamente para leitura. Não foram executados `test:isolation` ou testes de gravação nesse projeto. Disponibilizar backend descartável com 001–014 e testar login, expiração/renovação, RLS A/B, retry HTTP com resposta perdida, payload divergente, cache de schema e permissões de rotas novas/revogadas.
2. **Legados: inventário concluído, certificação pendente.** Conferir as cinco ocorrências e oito pagamentos de dívida com evidência externa. A receita futura pendente não deve ser realizada, cancelada ou reconstruída automaticamente. Documentar quais fatos são comprovados e quais permanecem indisponíveis; qualquer reparo remoto exige nova autorização.
3. **Safari/iPhone/PWA instalada: pendente.** Validar formulários, teclado/datas, atualização de versão e clientes abertos com backend isolado. Chrome em larguras móveis não substitui esse ensaio.
4. **Preparação da publicação:** revisão do conjunto frontend + 013 + 014, backup verificável e plano de recuperação que preserve evidências. Planejar cache/PWA e incompatibilidade dos clientes antigos; o frontend novo depende da 014. Revalidar a versão exata candidata após qualquer alteração.
5. **Autorização operacional:** somente após os itens anteriores, solicitar nova autorização para migrations remotas, merge e publicação. Nenhuma dessas ações está autorizada por esta auditoria.

Renegociação entre contratos e patrimônio retroativo completo continuam capacidades não certificadas, conforme o relatório original. Não afirmar suporte além dos cenários comprovados.
