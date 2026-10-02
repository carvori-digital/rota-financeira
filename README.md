# Rota Financeira · V0.2

React + TypeScript + Vite, Supabase Auth/Postgres e PWA mobile. A sessão é persistida pelo Supabase; dados financeiros ficam no banco e na memória da tela.

## Produto

A Home responde quanto existe no disponível, quanto ainda entra/sai, com o que o mês está comprometido e quanto ficará livre. O relatório mensal tem grupos expansíveis, pagamentos realizados, pendências, próximos vencimentos e projeção de quatro meses. Home e Planejar usam o mesmo agregador.

Planejar reúne Visão do mês, Próximos meses, Cartões, Dívidas / Parcelas, Recorrentes e Investimentos/Reserva. Novo oferece receita, despesa, agendamento, transferência, compra no cartão, dívida/parcelamento, pagamento de dívida e aporte/transferência. Configuração rápida orienta sete etapas sem exigir histórico anterior.

## Executar e validar

Node 22.18+ ou 24+, npm. Execute `npm ci`, copie `.env.example` para `.env.local` e configure somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`. Chaves administrativas são recusadas no frontend. `npm run dev`: http://127.0.0.1:5173; `npm run preview`: http://127.0.0.1:42817 após build.

- `npm test`: 60 testes (27 cálculos/PWA, 11 banco, 22 interface), com RLS, integridade, dados históricos, atomicidade e idempotência.
- `npm run typecheck`, `npm run lint`, `npm run build`: verificações adicionais; o build apresenta somente aviso de tamanho do bundle.
- `npm run test:mobile`: 30 verificações, incluindo 23 fluxos, em 375/390/430 px. PostgreSQL local com RLS, Auth/HTTP simulados e rede externa bloqueada. Defina `PLAYWRIGHT_MODULE` se Playwright estiver em runtime separado e `BROWSER_EXECUTABLE` para outro Chromium.
- `npm run test:live`: Auth/PostgREST real, duas identidades exclusivas QA, dados financeiros temporários, RLS A/B e fluxos V0.2. Limpa apenas dados dessas identidades, após verificar UUID, e-mail e finalidade. Os usuários QA são preservados, conforme a regra de não apagar usuários. Senhas ficam apenas na memória e em SQL temporário ignorado, removido após uso.
- `npm run validate:remote-data -- snapshot` e `-- verify`: fingerprints dos registros preexistentes e usuários, sem exportar valores ou senhas. `-- dry-run` é apenas para banco que ainda não recebeu 002–004; valida essas migrations em transação com rollback.

Relatórios e capturas ficam em `test-results/`, ignorado pelo Git.

## Regras financeiras

- Centavos inteiros. Digite `1250,50` sem separador de milhar. Contas podem ter saldo negativo.
- Lançamentos têm status explícito. Pendente não altera saldo, mesmo vencido. Confirmar/cancelar usa RPC própria e retira a pendência uma única vez. Uma data futura não realiza dinheiro automaticamente.
- Movimentos é o histórico realizado. Programadas ficam em Planejar. Receitas, despesas e ajustes realizados só afetam saldo a partir da data efetiva.
- Transferência é uma linha com origem/destino. Transferências internas não são consumo. Transferir para reserva reduz disponível e preserva patrimônio; metas registram progresso sem movimentar conta.
- Ajustar saldo atual gera lançamento interno rastreável, assinado, fora das receitas/despesas. O saldo inicial de conta existente é protegido contra reescrita.
- Recorrentes geram previsões. Cada ocorrência realizada ou pulada é removida da previsão, mantendo os meses seguintes. Marcações antigas podem virar regras sem duplicar o lançamento original.
- Parcelamento existente recebe valor mensal, parcela atual, total e próxima data. Deriva numeração, saldo, parcelas restantes e término; a última parcela fecha o saldo exatamente.
- Compras no cartão são consumo uma vez. Parcelas alimentam faturas; pagar fatura reduz conta e obrigação sem criar consumo novamente. Fatura manual cobre compras anteriores somente no mês importado; requisições repetidas não mudam cobertura.
- Pagamentos de dívida abatem caixa e saldo atomicamente, respeitam parcelas parciais e nunca ultrapassam saldo restante. RLS e FKs compostas impedem vínculos entre usuários.
- Reserva usa contas selecionadas e custo essencial manual ou sugerido por recorrentes. Patrimônio total soma contas antes de dívidas/cartões e aparece separado de dinheiro livre.
- Encargos conhecidos (juros/IOF/tarifa) podem ser agendados em Outros. Não há cálculo bancário automático de juros.

## Banco, publicação e PWA

Projeto existente Supabase `lgcozsoenycvifiygdsj`. Migrations incrementais 002, 003 e 004 aplicadas sobre a 001, após validação local e ensaio remoto com rollback. A migration histórica 001 não foi alterada. A baseline comprovou preservação do usuário e dos registros financeiros anteriores. Não usar `db reset` ou apagar dados reais.

Repositório: https://github.com/carvori-digital/rota-financeira. Destino Vercel existente: https://rota-financeira-delta.vercel.app/. Framework Vite, saída `dist`, variáveis públicas configuradas no projeto. O build publica `/release.json`, o commit em Ajustes e a mesma identidade no service worker. Na CLI, passe `VITE_RELEASE_COMMIT` no ambiente do build para identificar o commit exato.

A PWA usa manifest e ícones iOS. O worker não intercepta nem guarda respostas financeiras; a versão nova usa skipWaiting/clients.claim. A validação de publicação atualiza uma PWA previamente instalada, confere commit no domínio, login/logout real e as três larguras. `test:live -- --await-production` mantém as credenciais QA só em memória até receber um sinal fresco em `test-results/production-ready.json`.

No iPhone: Safari → Compartilhar → Adicionar à Tela de Início. É necessária conexão para consultar e salvar. Confirmação e recuperação de e-mail mantêm o fluxo existente; termos/privacidade e SMTP para distribuição pública ampla continuam fora deste fechamento funcional.
