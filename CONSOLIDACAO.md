# Consolidação — execução em 03/10/2026

Base imutável: `98d4fc49859d4c04f55154c644355b6a3f8d832c`.
Branch: `sprint/rota-financeira-consolidacao`.

## Auditoria anterior à implementação

Árvore limpa; origin/main local em `a4ae04004adbc37d7e74088d293515d881efd65b`.
Leitura remota realizada em transação READ ONLY no projeto solicitado.
Snapshot integral e inventário de colunas, constraints, triggers, policies,
funções e migrations: `test-results/consolidation-before-1791030370514.json`,
ignorado pelo Git. Não contém credenciais nem auth.users.

14 tabelas com RLS: accounts 3, categories 16, transactions 9, goals 1,
goal_contributions 0, credit_cards 2, card_purchases 2, card_invoices 1,
card_payments 0, debts 7, debt_payments 0, recurring_items 4,
recurring_occurrences 0, reserve_account_links 0. Migrations 001–004 presentes.
Baseline anterior: 20 registros idênticos; 25 posteriores preservados.
Baseline local: 32 testes unitários, 11 de banco e 25 de interface aprovados.

Home e Relatórios já compartilham projection/monthReport/experienceReport.
Investimentos ainda são accounts; não há razão de movimentos de investimento.
Reserva é definida por meta e links para contas. Metas não compõem saldos.
Compras têm valores imutáveis por trigger e DELETE revogado; pagamentos são
RPCs atômicas. Fatura manual é um baseline com covered_at, que exige cuidado
na correção de compras cobertas. Cartão exige conta; inputs aceitam decimais
sem máscara. Dívidas já possuem pagamentos parciais, numeração e projeção.
PWA não intercepta respostas financeiras; versão do SW deriva do commit.
Hooks paginam leituras, isolam snapshots por usuário e atualizam por visibilidade.

## Decisões de preservação

Migrar contas savings/investment sem obrigações pendentes para investimentos
manuais, mantendo origem, histórico e IDs antigos. Não inferir rentabilidade.
Contas com vínculos futuros exigem revisão antes da conversão.
Descrições semelhantes não provam duplicidade: preservar compras e dívidas,
criando pendências de classificação sem alterar seus valores.

Migrations remotas dependem de testes locais, revisão SQL, dry-run e comparação
dos invariantes. Merge/deploy dependem de todas as validações do pedido.

## Retomada em 04/10/2026

Os snapshots anteriores são históricos. O banco atual é a fonte da verdade;
nenhum snapshot deve ser restaurado. Antes da migration remota, gerar outro
snapshot READ ONLY com `scripts/snapshot-consolidation.mjs` e guardar o caminho
privadamente. `scripts/rehearse-consolidation.mjs` reproduz as migrations apenas
em PGlite na memória. `scripts/verify-consolidation.mjs` compara duas capturas
locais sem escrever no Supabase. Divergências podem representar uso legítimo;
exigem reconciliação, nunca restauração automática.

Criação de compra usa RPC invoker com INSERT ON CONFLICT DO NOTHING, comparação
do conteúdo e UUID estável. UPDATE genérico segue revogado. Edição/cancelamento
passam por RPC auditável; faturas com pagamentos exigem ajustes preservando o
histórico. A versão anterior precisa ser atualizada após a migration 006 para
usar o novo caminho de criação.

Investimentos usam juros compostos por movimento e dias corridos, com taxas
imutáveis e sincronização por diferença. Contas convertidas e transações
vinculadas ao razão são protegidas. A migração mantém contas e transações de
origem, importa em centavos e usa o calendário de São Paulo. A importação
mecânica serializa as tabelas de origem durante a transação. Revisões LOW não
alteram valores nem excluem registros.

Validação local: 35 testes unitários, 18 de banco, 26 de interface; 34 checks
mobile e 47 de experiência em 375/390/430 px. Typecheck, lint e build aprovados;
o build mantém aviso de bundle superior a 500 kB. O ensaio local da cópia
histórica de 50 registros preservou IDs, campos e invariantes financeiros.
Isso não substitui o snapshot fresco imediatamente anterior à aplicação.
