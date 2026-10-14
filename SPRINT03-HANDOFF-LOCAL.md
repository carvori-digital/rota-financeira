# ROTA FINANCEIRA — SPRINT 03 / handoff local

Entrega Cloud de 13/10/2026. **Nenhuma migration remota, escrita financeira real, reconstrução real, snapshot remoto, reset, merge ou publicação foi executada.** Não iniciar outro sprint automaticamente.

## Branch e commits

Branch: `feat/rota-sprint03-financial-clarity`.
Base sincronizada: `c60c5141a98b21a486b22e0b7977cea0f7b5c230` (`origin/main` no início).
Estado inicial limpo; branch anterior `work` preservada. Envio pela conexão GitHub `carvori-digital`: Git do ambiente (`yuri-vitt`) retornou 403. Os cinco checkpoints foram reproduzidos pelo conector; conteúdo das árvores verificado contra o local. A autoria do conector muda os hashes, sem modificar o código. Originais preservados localmente em `archive/rota-sprint03-cloud-original`.

- `983c8bf`: modelo único de compromissos Home/Planejar e evidência de agendamento.
- `66f0f11`: CDI diário, cache oficial, vigências e limites documentados.
- `1261929`: reconstrução segura de investimento migrado, com reconciliação.
- `0f02931`: relatórios financeiros locais PDF/CSV/JSON e completude.
- Commit final: ajustes visuais, ordenação do razão, testes e este handoff. Obter SHA exato com `git log -5 --oneline`; a versão final da migration 009 é a do HEAD da branch, incluindo `ledger_order`.

## Funcionalidades e limites

Compromissos: Home e Planejar usam `monthlyCommitments`. Despesas variáveis, receitas, transferências e ajustes não contam. Recorrências e faturas têm vínculo explícito; parcial não conclui. Novas programadas preservam vencimento original; `planning_group` com default NÃO prova agendamento antigo. Pagamentos de dívidas novos capturam valor integral da ocorrência. Histórico de dívida sem valor integral capturado não é promovido a concluído. Pagamentos que antecipam várias parcelas não têm alocação histórica detalhada por parcela; a ocorrência vinculada é contada uma vez, sem inventar as demais. Fluxo de caixa/projeção/saldo mantêm seus motores independentes.

CDI: modelo `percent_cdi`, incluindo 115%/100%, fatores SGS 12 diários, aportes com datas próprias, resgates e vigências imutáveis. Consulta explícita à API pública BCB; cache local somente do índice, com fonte/intervalo/data. Sem cobertura, mostra posição registrada e rendimento indisponível. Sincronização não cria dinheiro. SQL limita resgates CDI pela posição **registrada**, não pela estimativa: sincronizar saldo efetivo antes de resgatar rendimento. Não há valor líquido preciso por falta de lotes fiscais. Política CSP autoriza somente `https://api.bcb.gov.br` adicionalmente.

Reconstrução: duas etapas, preview de capital/posição/diferenças e confirmação explícita. Uma RPC transacional bloqueia versão desatualizada, mantém contas/transações/movimentos antigos, importa posição histórica sem débito, sincroniza alvo real e retira o antigo de telas/totais por `replaced_by_id`. Origem/auditoria protegidas; não muda usuários alheios. Reserva real só será reconstruída pelo usuário após implantação. Capital histórico não pode ficar negativo; extratos com resgates superiores aos aportes informados precisam de reconciliação, sem criar aportes fictícios. Não se afirma rendimento histórico exato anterior à âncora de sincronização.

Exportação: resumida por padrão, detalhe opcional, período e prévia. PDF paginado; CSV UTF-8 BOM, separador `;`, decimais brasileiros, escape de aspas e proteção contra fórmulas; JSON `rota-financial-export/1.0`, valores em centavos, referências auditáveis e whitelists. Diferencia realizado/programado/projetado/estimado. Snapshot por RPC `STABLE SECURITY INVOKER` aplica RLS + filtro de usuário, devolve arrays completos e contagens (testado acima de 1000 registros). Não há envio de dados financeiros para gerar arquivos. Troca de sessão/ocultação cancela download em andamento. JSON detalhado inclui contexto anterior ao período para reconciliar patrimônio atual; isso é avisado na interface.

Completude: ausência de confirmação não significa mês completo, inclusive setembro. Só meses encerrados, explicitamente confirmados e integralmente selecionados entram nas médias. Confirmação pode ser revertida a parcial. Não inferir renda ausente. Poupança média de meses completos fica indisponível quando não houver meses elegíveis. Patrimônio/dívida/reserva são posição atual na geração, não saldo histórico no fim do período. CSV mistura linhas de resumo/auditoria: filtrar `origem` antes de somar; não somar todas as linhas.

## Migrations preparadas (não aplicadas remotamente)

1. `202610130008_commitment_evidence.sql`: novos campos de evidência, triggers apenas para operações futuras; sem backfill de lançamentos antigos.
2. `202610130009_cdi_terms.sql`: novo modelo/limites, `ledger_order` identity, metadados de sincronização, tabela de vigências e RPCs. Identity adiciona somente ordem técnica aos registros existentes; campos financeiros preexistentes permanecem idênticos.
3. `202610130010_investment_reconstruction.sql`: referência de substituição, auditoria e RPC; nenhuma reconstrução automática.
4. `202610130011_financial_export.sql`: confirmação de completude e snapshot invoker; nenhuma alteração automática de registros financeiros.

Migrations 001–007 intactas. Todas as migrations novas têm `BEGIN/COMMIT`; funções definer usam `search_path=''`, validam `auth.uid()` e ownership; RPC de exportação é invoker. Grants de tabelas novas são somente SELECT para authenticated; escrita exclusivamente por RPC. Revalidar grants/default privileges no ambiente Supabase real.

## Dependências / validação Cloud

`jspdf` em runtime (import dinâmico ao baixar PDF); `playwright` somente desenvolvimento. Lockfile atualizado. Chromium local usado sem baixar navegador. Não houve novo serviço externo ou chave.

Aprovados: `npm test` (8 arquivos unitários, 5 arquivos de banco local e 32 testes UI), `npm run typecheck`, `npm run lint`, `npm run build`; testes sintéticos PGlite de atomicidade, RLS A/B/anon, dados preexistentes, stale reconciliation, idempotência, CDI, snapshot com >1000 linhas e completude. Mobile 375/390/430px: 77 verificações da experiência existente + 21 do sprint, nenhum pageerror ou tráfego externo. Capturas em `test-results/experience/` e `test-results/sprint03/` (gitignored). Inspeção visual realizada; números na reconciliação não quebram linha.

Build tem aviso não bloqueante de bundle principal acima de 500 kB; PDF fica em chunks sob demanda. PGlite não substitui PostgreSQL/Supabase/PostgREST real.

Não executados: migrations remotas, integração com dados financeiros reais, teste de RLS em Supabase real, CORS/rede BCB no navegador de produção, comparação com extrato Nubank real, tributação por lote, deploy Vercel e PWA instalada em celular físico. Os testes PWA existentes passaram; validação instalada fica para o local.

## Fontes e cálculo CDI

Ver `SPRINT03-CDI-RESEARCH.md`: URLs oficiais Nubank (Caixinhas e RDB), B3 (DI/metodologia) e BCB (SGS 12/API); fórmula, intervalo inicial inclusivo/final exclusivo, dias publicados, precisão e limitações. Fonte anual B3 não é tratada como taxa diária; SGS 12 já é `% a.d.`. IEEE-754 e arredondamento monetário somente no final não reproduzem truncamentos internos do banco. Texto B3 de acumulação disponível por resultado oficial indexado; abertura integral sofreu timeout. Não há hipótese de elegibilidade automática Turbo nem Selic substituta.

## Roteiro exato para o Codex local

Executar somente após validação local/autorização de implantação. Nunca restaurar snapshot antigo; usuário continua lançando dados.

1. Preservar trabalho local (`git status --short`). Não usar checkout/reset que descarte alterações. Então:

   ```sh
   git fetch origin
   git switch feat/rota-sprint03-financial-clarity
   git pull --ff-only origin feat/rota-sprint03-financial-clarity
   git log -5 --oneline
   git diff --stat origin/main...HEAD
   git diff origin/main...HEAD -- supabase/migrations
   git diff origin/main...HEAD -- supabase/migrations/202610010001_initial.sql supabase/migrations/202610010002_planning.sql supabase/migrations/202610010003_planning_integrity.sql supabase/migrations/202610020004_financial_clarity.sql supabase/migrations/202610030005_investments.sql supabase/migrations/202610030006_card_corrections.sql supabase/migrations/202610050007_record_management.sql
   ```

   A última comparação deve estar vazia. Se main avançou, integrar com revisão de conflitos na branch antes de qualquer migration; refazer checks.

2. Revisar migrations 008–011, RPCs, grants/RLS, ordem do razão, cache e whitelists. Ensaiar em banco efêmero:

   ```sh
   npm ci
   npm test
   npm run typecheck
   npm run lint
   npm run build
   PLAYWRIGHT_EXECUTABLE_PATH=/caminho/real/do/chromium npm run test:experience
   PLAYWRIGHT_EXECUTABLE_PATH=/caminho/real/do/chromium npm run test:sprint03-mobile
   ```

   No Windows, ajustar a variável conforme shell ou configurar navegador Playwright. Prévia é isolada; não usa Supabase real. Não usar `db reset`, nem para o ensaio. PGlite já cria/descarta bancos privados em memória.

3. Confirmar conta/projeto Supabase atualmente vinculados e comparar com o destino configurado em `scripts/remote-sql.mjs`/`snapshot-consolidation.mjs`; scripts existentes têm referência de projeto fixa. NÃO executar se o projeto atual não corresponder. Não imprimir tokens/senhas, usar autenticação local aprovada.

4. Criar snapshot **FRESCO, privado e somente leitura** imediatamente antes da implantação:

   ```sh
   mkdir -p test-results
   npm run snapshot:records
   ```

   Guardar localmente o nome retornado, hash `.sha256`, schema/migrations, IDs/contagens por usuário e invariantes. Os scripts de snapshot foram estendidos para reconhecer as tabelas novas; não executados no Cloud. Diretório é gitignored; não anexar snapshots ao Git/PR/chat. Este snapshot JSON de validação não é um backup completo de auth/storage; manter também backup fresco do banco conforme procedimento privado aprovado (por exemplo `supabase db dump --linked` para schema/data/roles), sem restauração automática.

5. Confirmar migrations reais e dry-run:

   ```sh
   supabase migration list --linked
   supabase db push --linked --dry-run
   ```

   Prosseguir só se 001–007 corresponderem ao schema real e as ÚNICAS pendências forem 202610130008–011. Se aparecer migration antiga, schema divergente ou nova numeração concorrente, parar e reconciliar; não usar `migration repair`, `--include-all` ou reset para forçar.

6. Comparar os campos financeiros/invariantes com o estado atual (disponível, contas, investimentos/reserva, dívidas, faturas, patrimônio bruto/líquido, vínculos por usuário). Planejar janela breve para facilitar atribuição de mudanças a operações do usuário; não supor que o banco está congelado. Migration é exclusivamente estrutural e não deve alterar valor, data, status, IDs, ownership ou vínculos preexistentes.

7. Aplicar somente após revisão segura e autorização local:

   ```sh
   supabase db push --linked
   supabase migration list --linked
   npm run snapshot:records
   node scripts/verify-sprint03-snapshots.mjs test-results/ARQUIVO-ANTES.json test-results/ARQUIVO-DEPOIS.json
   ```

   O comparador é local, valida SHA e TODOS os campos antigos, sem tolerar mudanças em `accounts`. Novos campos estruturais são esperados. Adições/edições reais concorrentes precisam de explicação pelo histórico; não atribuir automaticamente à migration e não restaurar o snapshot anterior. Conferir invariantes por usuário dos dois snapshots. Ausência de RPC de reconstrução executada deve implicar zero linhas na auditoria nova e zero substituições novas.

8. Validar SECURITY INVOKER da exportação, ownership/RLS A/B e anon com duas sessões de teste autorizadas (dados sintéticos separados); confirmar que exportação A não tem B, índices não contêm dados financeiros, RPCs não aceitam IDs de B, tabelas/auditoria não permitem escrita genérica. Conferir grants e schema cache PostgREST. Validar arrays com >1000 registros no ambiente efêmero, não inserir teste em produção.

9. Em prévia/staging aprovado, testar variável que não aumenta contador; fixas/programadas concluídas; parcial; cancelamento; Home = Planejar; vigência CDI; saldo manual sem histórico; CDI offline/CORS; importar histórico apenas em investimento de teste migrado; stale preview; retry; exclusão/reativação protegidas; arquivos válidos e reconciliação dos totais; mês parcial/completo; sessão trocada; valores ocultos. Nunca usar a reserva real para ensaio.

10. Fazer merge seguro pelo fluxo do repositório após validação. Exemplos locais, com árvore limpa e main sincronizada:

    ```sh
    git switch main
    git pull --ff-only origin main
    git merge --no-ff feat/rota-sprint03-financial-clarity
    ```

    Revisar/reexecutar os checks no resultado; enviar main somente após autorização de publicação. Se o projeto publicar automaticamente a main, o push já é a etapa de publicação, não um passo neutro.

11. Publicar na Vercel pelo fluxo atual (integração Git ou CLI local aprovada). Confirmar destino, variáveis públicas VITE Supabase e CSP BCB; nenhuma chave service_role deve ser VITE. Para CLI explícita, `vercel --prod` somente após validação/merge e autorização. Não alterar audiência ou infraestrutura desnecessariamente.

12. Confirmar Vercel **READY**, commit servido em `/release.json`, nova versão carregada e service worker atualizado. Deployment com URL antes de READY não comprova sucesso.

13. Validar no celular real/PWA: 375/390/430px, ausência de overflow, toque nos controles, downloads PDF/CSV/JSON nos navegadores alvo, volta ao app, cache de CDI offline e etiquetas de estimativa/completude. Comparar saldo com banco sem fazer reconstrução automaticamente.

14. Deixar a reconstrução efetiva da reserva para **ação explícita do usuário** na interface, com extratos/datas/valor real atual e revisão das diferenças. Não disparar RPC em migration, deploy, script de manutenção ou primeiro login.

## Pendências e riscos para implantação

- Revisão local de PostgreSQL/PostgREST real, RLS/default privileges e tempo/limites da resposta JSON, especialmente bases grandes.
- Fallback de CDI depende de cache válido ou sincronização manual; CORS/fonte precisam ser testados no navegador de destino. Fonte pode ter atrasos/omissões de publicação; não há calendário B3 independente para detectá-los.
- Sem cálculo fiscal líquido nem precisão centavo a centavo contratual. Condições Turbo e eventual resgate/reaplicação devem ser conferidos no extrato individual.
- Datas históricas de aportes e valor atual são informações do usuário, não inferências automáticas. Reconstrução registra diferenças explicitamente, mantém origem e impede repetição.
- Registros novos adicionam metadados; migrations não reclassificam histórico comum como compromissos. Histórico ambíguo permanece conservador.
- Não fazer rollback por restauração de snapshot enquanto o usuário lança dados. Se falhar uma etapa, preservar dados e preparar correção incremental revisada.
