-- Somente leitura. Executar SOMENTE em banco isolado com dados sintéticos.
-- Compatível com 001–013 e com 014. Resultados são sinais para revisão,
-- não autorização para corrigir ou inferir fatos históricos automaticamente.
begin transaction read only;

-- Deve ser vazio: comprovantes sem o movimento financeiro correspondente.
select 'payment_without_matching_cash' as finding, 'debt' as module, p.user_id, p.id
from public.debt_payments p left join public.transactions t
  on t.id=p.transaction_id and t.user_id=p.user_id
where t.id is null or t.type<>'expense' or t.status<>'realized'
   or t.amount_cents<>p.amount_cents or t.transaction_date<>p.payment_date
union all
select 'payment_without_matching_cash', 'card', p.user_id, p.id
from public.card_payments p left join public.transactions t
  on t.id=p.transaction_id and t.user_id=p.user_id
where t.id is null or t.type<>'card_payment' or t.status<>'realized'
   or t.amount_cents<>p.amount_cents or t.transaction_date<>p.payment_date;

-- Requer comprovante externo para detalhar competências de antecipações antigas.
-- Na 014, verificar também se debt_payment_allocations já cobre o pagamento.
select 'legacy_multi_installment_evidence' as finding,
       p.user_id,p.id,p.debt_id,p.amount_cents,p.scheduled_date,p.obligation_amount_cents
from public.debt_payments p
where p.obligation_amount_cents is not null
  and p.amount_cents>p.obligation_amount_cents;

-- Pode ser alteração legítima de regra: não substituir o lançamento pela regra.
select 'rule_differs_from_recorded_fact' as finding,o.user_id,o.id,o.due_date,
       r.type as current_rule_type,t.type as recorded_type,
       r.account_id as current_rule_account,t.account_id as recorded_account
from public.recurring_occurrences o
join public.recurring_items r on r.id=o.recurring_item_id and r.user_id=o.user_id
join public.transactions t on t.id=o.transaction_id and t.user_id=o.user_id
where o.status='recorded' and
      (r.type,r.account_id,r.category_id) is distinct from
      (t.type,t.account_id,t.category_id);

-- Obrigações gravadas fora do calendário atual devem continuar visíveis.
select 'stored_obligation_outside_current_calendar' as finding,
       o.user_id,o.id,o.due_date,o.amount_cents,r.active
from public.recurring_occurrences o
join public.recurring_items r on r.id=o.recurring_item_id and r.user_id=o.user_id
where o.status='planned' and (not r.active or not public.is_recurring_date(r,o.due_date));

-- Identifica previsões de compra que não podem entrar no patrimônio realizado.
select 'future_card_purchase' as finding,user_id,id,purchase_date,amount_cents
from public.card_purchases
where cancelled_at is null and purchase_date>public.financial_date();

-- Inventário das rotas de compatibilidade. delete_investment continua chamável
-- na 014 para retornar erro explícito; seu corpo deve bloquear a operação.
select p.oid::regprocedure::text as route,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as callable
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('delete_investment','record_investment_movement','adjust_account_balance',
  'simple_investment_movement','delete_simple_investment','create_financial_transaction')
order by route;

rollback;
