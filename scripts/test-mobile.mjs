// Local browser integration: real migrated PostgreSQL, simulated Auth/HTTP,
// and all outbound requests blocked. No remote Supabase or production writes.
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const db = new PGlite();
let browser, server, activePage;
const user = randomUUID(),
  api = "https://local-only.supabase.test";
const results = [],
  errors = [],
  outbound = [];
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const names = new Set([
  "account_overdraft_versions",
  "bank_reconciliations",
  "accounts",
  "categories",
  "transactions",
  "goals",
  "goal_contributions",
  "recurring_items",
  "recurring_occurrences",
  "recurring_payments",
  "credit_cards",
  "card_purchases",
  "card_subscriptions",
  "card_subscription_versions",
  "card_subscription_occurrences",
  "card_invoices",
  "card_payments",
  "debts",
  "debt_payments",
  "debt_payment_allocations",
  "reserve_account_links",
  "investments",
  "investment_movements",
  "classification_reviews",
  "card_adjustments",
  "investment_rates",
  "investment_reconstructions",
]);
const identifier = (value) => {
  assert.match(value, /^[a-z_]+$/);
  return `"${value}"`;
};
const normalize = (rows) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date
          ? value
              .toISOString()
              .slice(
                0,
                key === "date" ||
                  key.endsWith("_date") ||
                  key === "charge_month" ||
                  key === "effective_month"
                  ? 10
                  : 24,
              )
          : key.endsWith("_cents") && value !== null
            ? Number(value)
            : value,
      ]),
    ),
  );
try {
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
  for (const name of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await query("insert into auth.users(id) values($1)", [user]);
  await query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec("set role authenticated");
  const cash = (
    await query(
      "insert into accounts(name,type,initial_balance_cents) values('Conta local','checking',100000) returning id",
    )
  )[0].id;
  const reserve = (
    await query(
      "insert into accounts(name,type,initial_balance_cents) values('Poupança local','savings',200000) returning id",
    )
  )[0].id;
  const expense = (
    await query(
      "select id from categories where name='Alimentação' and type='expense'",
    )
  )[0].id;
  const today = (
    await query("select financial_date()::text as financial_day")
  )[0].financial_day;
  await query(
    "insert into goals(name,target_amount_cents) values('Viagem local',100000)",
  );
  server = await createServer({
    configFile: false,
    envDir: false,
    plugins: [react()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(api),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(
        "sb_publishable_local_test",
      ),
    },
    server: { host: "127.0.0.1", port: 5174, strictPort: true },
  });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.BROWSER_EXECUTABLE ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    timezoneId: "America/Sao_Paulo",
    locale: "pt-BR",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [
    { alg: "HS256", typ: "JWT" },
    { sub: user, aud: "authenticated", role: "authenticated", exp: expires },
    "local-only",
  ]
    .map((part) =>
      typeof part === "string"
        ? part
        : Buffer.from(JSON.stringify(part)).toString("base64url"),
    )
    .join(".");
  const session = {
    access_token: jwt,
    refresh_token: "local-only",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expires,
    user: {
      id: user,
      aud: "authenticated",
      role: "authenticated",
      email: "fixture@example.test",
      app_metadata: { provider: "email" },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
  await context.addInitScript(
    ({ session }) => {
      localStorage.setItem("sb-local-only-auth-token", JSON.stringify(session));
    },
    { session },
  );
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:5174") return route.continue();
    if (url.origin !== api) {
      outbound.push(request.url());
      return route.abort();
    }
    try {
      if (url.pathname.startsWith("/auth/"))
        return route.fulfill({
          json: url.pathname.endsWith("/user") ? session.user : {},
        });
      const parts = url.pathname.split("/").filter(Boolean),
        table = parts.at(-1),
        payload = request.postDataJSON();
      let rows = [];
      if (parts.includes("rpc")) {
        assert.ok(
          [
            "save_account_overdraft",
            "record_bank_reconciliation",
            "save_card_subscription",
            "resolve_card_subscription",
            "set_card_invoice",
            "pay_card_invoice",
            "pay_debt",
            "resolve_recurring",
            "create_financial_transaction",
            "record_recurring_payment",
            "set_recurring_occurrence_amount",
            "repeat_transaction",
            "save_emergency_reserve",
            "create_card_purchase",
            "correct_card_purchase",
            "adjust_card_purchase",
            "record_investment_movement",
            "keep_classification",
            "resolve_transaction",
            "adjust_account_balance",
            "reconcile_operational_balance",
            "create_simple_investment",
            "simple_investment_movement",
            "delete_simple_investment",
            "reverse_simple_investment_movement",
          ].includes(table),
        );
        const keys = Object.keys(payload),
          args = keys.map((key) =>
            key === "p_payload" ? JSON.stringify(payload[key]) : payload[key],
          );
        rows = await query(
          `select public.${identifier(table)}(${keys.map((key, i) => `${identifier(key)} => $${i + 1}${key === "p_accounts" ? "::uuid[]" : key === "p_payload" ? "::jsonb" : ""}`).join(",")}) result`,
          args,
        );
        return route.fulfill({ json: rows[0].result });
      }
      assert.ok(names.has(table));
      const args = [],
        where = [];
      for (const [key, value] of url.searchParams)
        if (value.startsWith("eq.")) {
          args.push(value.slice(3));
          where.push(`${identifier(key)}=$${args.length}`);
        }
      const clause = where.length ? ` where ${where.join(" and ")}` : "";
      if (request.method() === "GET")
        rows = await query(
          `select * from public.${identifier(table)}${clause} order by id limit ${Number(url.searchParams.get("limit") ?? 500)} offset ${Number(url.searchParams.get("offset") ?? 0)}`,
          args,
        );
      else if (request.method() === "PATCH") {
        const keys = Object.keys(payload),
          values = keys.map((key) => payload[key]);
        rows = await query(
          `update public.${identifier(table)} set ${keys.map((key, i) => `${identifier(key)}=$${args.length + i + 1}`).join(",")}${clause} returning *`,
          [...args, ...values],
        );
      } else if (request.method() === "POST") {
        const keys = Object.keys(payload),
          values = keys.map((key) => payload[key]);
        rows = await query(
          `insert into public.${identifier(table)}(${keys.map(identifier).join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")})${
            request.headers().prefer?.includes("resolution=merge-duplicates")
              ? ` on conflict(id) do update set ${keys
                  .filter((key) => key !== "id")
                  .map(
                    (key) => `${identifier(key)}=excluded.${identifier(key)}`,
                  )
                  .join(",")}`
              : ""
          } returning *`,
          values,
        );
      } else if (request.method() === "DELETE")
        rows = await query(
          `delete from public.${identifier(table)}${clause} returning *`,
          args,
        );
      else throw new Error(`Unsupported method ${request.method()}`);
      await route.fulfill({ json: normalize(rows) });
    } catch (error) {
      await route.fulfill({
        status: 400,
        json: {
          message: error.message,
          code: error.code ?? "local_test_error",
        },
      });
    }
  });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = (name) =>
    name === "Planejar"
      ? {
          click: async () => {
            await page
              .getByRole("navigation")
              .getByRole("button", { name: "Início", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Planejar", exact: true })
              .click();
          },
        }
      : page.getByRole("navigation").getByRole("button", { name, exact: true });
  const tab = (name) => ({
    click: async () => {
      if ((await page.getByRole("tab", { name, exact: true }).count()) === 0) {
        await nav(
          [
            "Contas",
            "Cartões",
            "Assinaturas",
            "Investimentos e reserva",
            "Dívidas e parcelas",
          ].includes(name)
            ? "Carteira"
            : "Planejar",
        ).click();
      }
      await page.getByRole("tab", { name, exact: true }).click();
    },
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const field = (label) => page.getByLabel(label, { exact: true });
  const save = async () => {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salvar", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByText("Atualizando dados…", { exact: true })
      .waitFor({ state: "hidden" });
  };
  const quick = async (name) => {
    await nav("Novo").click();
    if (name === "Pagamento de dívida")
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Pagamento", exact: true })
        .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: true })
      .click();
  };
  const confirmInvestment = async () => {
    await button("Conferir movimentação").click();
    await page
      .getByLabel("Conferi os valores e confirmo esta movimentação")
      .check();
    await button("Confirmar movimentação").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  };
  const capture = async (name) => {
    await mkdir("test-results/mobile", { recursive: true });
    await page.screenshot({
      path: `test-results/mobile/${name}.png`,
      fullPage: true,
    });
  };
  const fit = async (name) => {
    const dimensions = await page.evaluate(() => ({
      viewport: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.scroll <= dimensions.viewport,
      `${name}: ${JSON.stringify(dimensions)}`,
    );
    results.push(name);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto("http://127.0.0.1:5174", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      break;
    } catch (e) {
      if (attempt === 2 || !e.message.includes("ERR_NETWORK_IO_SUSPENDED"))
        throw e;
      console.log("Chrome retomando rede após suspensão do Windows.");
    }
  }
  await page
    .getByText("Posição prevista no fim do mês", { exact: true })
    .waitFor({ timeout: 30000 });
  await nav("Planejar").click();
  await tab("Cartões").click();
  await button("Adicionar cartão").first().click();
  await field("Nome").fill("Cartão local");
  await field("Limite (R$) · opcional").fill("2000,00");
  await field("Dia do fechamento").fill("20");
  await field("Dia do vencimento").fill("28");
  await fit("375px criar cartão");
  await capture("375-card-form");
  await save();
  await button("Editar cartão").first().click();
  await field("Nome").fill("Cartão editado");
  await save();
  assert.equal(
    (await query("select name from credit_cards"))[0].name,
    "Cartão editado",
  );
  await nav("Início").click();
  await quick("Compra no cartão");
  await field("Valor (R$)").fill("100,01");
  await field("Categoria").selectOption(expense);
  await field("Descrição").fill("Compra parcelada");
  await field("Número de parcelas").fill("3");
  await save();
  console.log("cartão e compra: OK");
  await nav("Planejar").click();
  await tab("Cartões").click();
  await button("Informar fatura atual").click();
  await field("Valor (R$)").fill("120,00");
  await field("Vencimento").fill(`${today.slice(0, 7)}-28`);
  await save();
  await button("Pagar fatura").first().click();
  await field("Valor (R$)").fill("20,00");
  await save();
  assert.equal(
    Number(
      (await query("select sum(amount_cents) amount from card_payments"))[0]
        .amount,
    ),
    2000,
  );
  await tab("Dívidas e parcelas").click();
  await button("Adicionar dívida").first().click();
  await field("Nome").fill("Dívida local");
  await field("Dívida original (R$)").fill("300,00");
  await field("Quanto falta pagar (R$)").fill("250,00");
  await field("Parcela mensal (R$) · opcional").fill("100,00");
  await field("Próximo vencimento · opcional").fill(`${today.slice(0, 7)}-28`);
  await save();
  await button("Editar dívida").click();
  await field("Nome").fill("Dívida editada");
  await field("Próximo vencimento · opcional").fill(`${today.slice(0, 7)}-27`);
  await field("Parcela mensal (R$) · opcional").fill("80,00");
  await save();
  await nav("Início").click();
  await quick("Pagamento de dívida");
  await field("Valor (R$)").fill("30,00");
  await save();
  assert.equal(
    Number(
      (await query("select remaining_amount_cents from debts"))[0]
        .remaining_amount_cents,
    ),
    22000,
  );
  await nav("Planejar").click();
  await tab("Recorrentes").click();
  await button("Adicionar recorrente").click();
  await field("Nome").fill("Conta essencial");
  await field("Valor (R$)").fill("50,00");
  await field("Categoria").selectOption(expense);
  await field("Primeira ocorrência").fill(today);
  await field("Despesa essencial").check();
  await save();
  await button("Editar regra").click();
  await field("Valor (R$)").fill("60,00");
  await save();
  await button("Realizar").first().click();
  await page
    .getByText("Atualizando dados…", { exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByText("Ocorrências realizadas e puladas", { exact: true })
    .click();
  await page.getByText("Realizado", { exact: true }).waitFor();
  await button("Pular").first().click();
  await page
    .getByText("Atualizando dados…", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    (await query("select * from recurring_occurrences where status='skipped'"))
      .length,
    1,
  );
  await tab("Investimentos e reserva").click();
  await button("Ajustar reserva").click();
  await field(
    "Custo essencial mensal (R$) · deixe vazio para usar sugestão",
  ).fill("100,00");
  await field("Meses de proteção").fill("6");
  await save();
  assert.equal((await query("select * from reserve_account_links")).length, 1);
  await button("Adicionar investimento").click();
  await field("Nome").fill("Reserva com rendimento");
  await field("Instituição").fill("Banco local");
  await field("Saldo inicial já existente (R$)").fill("500,00");
  await field("Rendimento").selectOption("fixed_annual");
  await field("Taxa fixa (%) ou percentual do CDI (ex.: 115)").fill("10");
  await field("Reserva de emergência").check();
  await page.getByLabel(/Conferi que este saldo/).check();
  await save();
  await button("Aportar").click();
  await field("Valor (R$)").fill("100,00");
  await field("Conta de origem").selectOption(cash);
  await page.getByLabel(/este movimento ainda não foi registrado/).check();
  await confirmInvestment();
  await button("Resgatar").click();
  await field("Valor (R$)").fill("25,00");
  await field("Conta de destino").selectOption(cash);
  await page.getByLabel(/este movimento ainda não foi registrado/).check();
  await confirmInvestment();
  await page.getByText("Valor real e histórico", { exact: true }).click();
  await button("Sincronizar valor atual").click();
  await field("Valor real no banco (R$)").fill("80,00");
  await field("Descrição").fill("Conferência local");
  await confirmInvestment();
  assert.equal(
    Number(
      (
        await query(
          "select investment_value(id,financial_date()) value from investments",
        )
      )[0].value,
    ),
    8000,
  );
  assert.equal((await query("select * from investment_movements")).length, 4);
  results.push(
    "investimento com taxa fixa, aporte, resgate e sincronização atômicos via UI/RLS",
  );
  await nav("Início").click();
  await quick("Receita");
  await field("Valor (R$)").fill("200,00");
  await field("Categoria").selectOption({ label: "Salário" });
  await field("Conta").selectOption(cash);
  await save();
  await quick("Despesa");
  await field("Valor (R$)").fill("10,00");
  await field("Categoria").selectOption(expense);
  await field("Conta").selectOption(reserve);
  await save();
  await quick("Receita");
  assert.equal(await field("Conta").inputValue(), reserve);
  await button("Fechar").click();
  await quick("Transferência");
  await field("Conta de origem").selectOption(cash);
  await field("Conta de destino").selectOption(reserve);
  await field("Valor (R$)").fill("40,00");
  await save();
  await quick("Metas e transferências");
  await button("Aportar em Viagem local").click();
  await field("Valor (R$)").fill("25,00");
  await save();
  assert.equal((await query("select * from goal_contributions")).length, 1);
  // Creating a transaction with recurrence uses the real atomic RPC.
  await quick("Despesa");
  await field("Valor (R$)").fill("5,00");
  await field("Categoria").selectOption(expense);
  await field("Conta").selectOption(cash);
  await field("Recorrente").check();
  await save();
  assert.equal((await query("select * from recurring_items")).length, 2);
  results.push(
    "16 fluxos: criar/editar cartão, compra parcelada, fatura, pagamento, criar/editar dívida, pagamento, criar/editar recorrência, realizar/pular, reserva, receita/despesa, transferência, aporte, repetição atômica e conta lembrada",
  );
  // Explicit pending status remains non-cash even with a past planned date.
  const actualCash = async () =>
    Number(
      (
        await query(
          "select a.initial_balance_cents+coalesce(sum(case when t.account_id=a.id then case t.type when 'income' then t.amount_cents when 'adjustment' then t.adjustment_delta_cents else -t.amount_cents end else 0 end+case when t.type='transfer' and t.destination_account_id=a.id then t.amount_cents else 0 end),0) amount from accounts a left join transactions t on t.user_id=a.user_id and t.status='realized' and t.transaction_date<=financial_date() where a.id=$1 group by a.id",
          [cash],
        )
      )[0].amount,
    );
  const beforePending = await actualCash();
  await quick("Programar");
  await field("Descrição").fill("Tarifa programada");
  await field("Valor (R$)").fill("10,00");
  await field("Conta").selectOption(cash);
  await field("Categoria").selectOption(expense);
  await field("Data prevista").fill("2020-01-01");
  await field("Grupo").selectOption("other");
  await save();
  assert.equal(await actualCash(), beforePending);
  assert.equal(
    (
      await query(
        "select status from transactions where description='Tarifa programada'",
      )
    )[0].status,
    "pending",
  );
  await nav("Planejar").click();
  await tab("Programadas").click();
  const scheduled = () =>
    page
      .getByRole("tabpanel")
      .locator("article")
      .filter({ hasText: "Tarifa programada" });
  await scheduled()
    .getByRole("button", { name: "Editar programada", exact: true })
    .click();
  await field("Valor (R$)").fill("12,00");
  await save();
  await scheduled()
    .getByRole("button", { name: "Confirmar / cancelar", exact: true })
    .click();
  await save();
  assert.equal(await actualCash(), beforePending - 1200);
  await quick("Programar");
  await field("Descrição").fill("Cancelar programada");
  await field("Valor (R$)").fill("10,00");
  await field("Conta").selectOption(cash);
  await field("Categoria").selectOption(expense);
  await save();
  await page
    .getByRole("tabpanel")
    .locator("article")
    .filter({ hasText: "Cancelar programada" })
    .getByRole("button", { name: "Confirmar / cancelar", exact: true })
    .click();
  await field("Ação").selectOption("cancel");
  await save();
  assert.equal(await actualCash(), beforePending - 1200);
  await quick("Dívida / parcelamento");
  await field("Nome").fill("Parcelamento 8 de 14");
  await field("Valor por parcela (R$)").fill("100,00");
  await field("Parcela atual").fill("8");
  await field("Total de parcelas").fill("14");
  await field("Saldo restante conhecido (R$) · opcional").fill("650,00");
  await field("Próximo vencimento").fill(today.slice(0, 7) + "-31");
  await save();
  await tab("Dívidas e parcelas").click();
  await page.getByText(/Parcela 8\/14/).waitFor();
  await nav("Ajustes").click();
  await button("Gerenciar contas na Carteira").click();
  await page
    .locator(".settings-account")
    .filter({ hasText: "Conta local" })
    .locator(":scope > summary")
    .click();
  await page
    .locator(".settings-account")
    .filter({ hasText: "Conta local" })
    .getByRole("button", { name: "Ajustar saldo atual", exact: true })
    .click();
  await field("Saldo atual correto (R$)").fill("-25,00");
  await button("Conferir reconciliação").click();
  await page
    .getByLabel(
      "Conferi os movimentos existentes e faltantes; confirmo o ajuste",
    )
    .check();
  await button("Confirmar ajuste de saldo").click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await actualCash(), -2500);
  assert.equal(
    Number(
      (
        await query("select initial_balance_cents from accounts where id=$1", [
          cash,
        ])
      )[0].initial_balance_cents,
    ),
    100000,
  );
  await nav("Início").click();
  await button("Configuração rápida").click();
  for (let i = 0; i < 6; i++) await button("Continuar / pular etapa").click();
  await button("Ver minha Home").click();
  await page
    .getByText("Posição prevista no fim do mês", { exact: true })
    .waitFor();
  results.push(
    "programada vencida não altera caixa; editar; confirmar uma vez; cancelar; parcela 8/14; ajuste negativo rastreável; configuração rápida",
  );
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await nav("Início").click();
    await page
      .getByText("Posição prevista no fim do mês", { exact: true })
      .waitFor();
    await fit(`${width}px Home`);
    await capture(`${width}-home`);
    await nav("Planejar").click();
    for (const name of [
      "Visão do mês",
      "Programadas",
      "Cartões",
      "Dívidas e parcelas",
      "Recorrentes",
      "Investimentos e reserva",
    ]) {
      await tab(name).click();
      await fit(`${width}px ${name}`);
      await capture(
        `${width}-${["Programadas", "Cartões", "Dívidas e parcelas", "Recorrentes", "Investimentos e reserva"].indexOf(name)}`,
      );
    }
    await tab("Cartões").click();
    await button("Compra no cartão").click();
    await fit(`${width}px compra parcelada modal`);
    await button("Fechar").click();
    await tab("Investimentos e reserva").click();
    await button("Adicionar investimento").click();
    await fit(`${width}px investimento modal`);
    await capture(`${width}-investment-form`);
    await button("Fechar").click();
    for (const [label, accountLabel] of [
      ["Aportar em investimento", "Conta de origem"],
      ["Resgatar investimento", "Conta de destino"],
    ]) {
      await quick(label);
      await field(accountLabel).selectOption(cash);
      await field("Valor (R$)").fill("10,00");
      await page.getByLabel(/este movimento ainda não foi registrado/).check();
      await fit(`${width}px ${label} formulário`);
      await button("Conferir movimentação").click();
      await fit(`${width}px ${label} confirmação`);
      await capture(
        `${width}-${label.startsWith("Aportar") ? "contribution" : "withdrawal"}-preview`,
      );
      await button("Fechar").click();
    }
    const investmentActions = page
      .getByText("Ações do registro", { exact: true })
      .first();
    if ((await investmentActions.locator("..").getAttribute("open")) === null)
      await investmentActions.click();
    await button("Excluir investimento").click();
    await fit(`${width}px exclusão confirmada`);
    await capture(`${width}-delete-investment`);
    await button("Fechar").click();
    await nav("Ajustes").click();
    await button("Gerenciar contas na Carteira").click();
    const accountSettings = page
      .locator(".settings-account")
      .filter({ hasText: "Conta local" });
    if ((await accountSettings.getAttribute("open")) === null)
      await accountSettings.locator(":scope > summary").click();
    await page
      .locator(".settings-account")
      .filter({ hasText: "Conta local" })
      .getByRole("button", { name: "Ajustar saldo atual", exact: true })
      .click();
    await fit(`${width}px reconciliação de conta`);
    await button("Conferir reconciliação").click();
    await fit(`${width}px diferença de saldo`);
    await button("Fechar").click();
    await nav("Planejar").click();

    await tab("Dívidas e parcelas").click();
    await button("Registrar pagamento").first().click();
    await fit(`${width}px pagamento dívida modal`);
    await button("Fechar").click();
  }
  // Hotfix regression fixtures and real RPCs: disposable PostgreSQL only.
  const hotfixRule = randomUUID(),
    paidId = randomUUID();
  await query(
    "insert into recurring_items(id,name,type,amount_cents,account_id,category_id,frequency,start_date) values($1,'Cemig hotfix quitada','expense',36337,$2,$3,'monthly',$4)",
    [hotfixRule, cash, expense, today],
  );
  await query("select resolve_recurring($1,$2,$3,false)", [
    paidId,
    hotfixRule,
    today,
  ]);
  await query("update recurring_items set amount_cents=39678 where id=$1", [
    hotfixRule,
  ]);
  const nextDue = (
    await query(
      "select public.month_day(($1::date+interval '1 month')::date,extract(day from $1::date)::integer)::text d",
      [today],
    )
  )[0].d;
  await query("select set_recurring_occurrence_amount($1,$2,39678)", [
    hotfixRule,
    nextDue,
  ]);
  // A retired origin is created only by privileged migration/deletion code.
  // Seed that post-deletion state as the owner of the disposable database.
  await db.exec("reset role");
  await query(
    "insert into accounts(user_id,name,type,initial_balance_cents,is_active,investment_retired) values($1,'Reserva hotfix excluída','investment',48866,false,true)",
    [user],
  );
  await db.exec("set role authenticated");
  await query("select create_simple_investment($1,$2::jsonb)", [
    randomUUID(),
    JSON.stringify({
      name: "Caixinha Turbo hotfix",
      institution: "Nubank",
      type: "RDB",
      initial_date: today,
      initial_cents: 59069,
      yield_type: "manual",
      yield_rate: 0,
      reserve: true,
      acknowledged: true,
    }),
  ]);
  for (const width of [375, 390, 430]) {
    const partialRule = randomUUID(),
      partialId = randomUUID(),
      skipRule = randomUUID();
    await query(
      "insert into recurring_items(id,name,type,amount_cents,account_id,category_id,frequency,start_date) values($1,$2,'expense',10000,$3,$4,'monthly',$5)",
      [partialRule, `Cemig parcial ${width}`, cash, expense, today],
    );
    await query("select record_recurring_payment($1,$2,$3,5000,$3)", [
      partialId,
      partialRule,
      today,
    ]);
    await query(
      "insert into recurring_items(id,name,type,amount_cents,account_id,category_id,frequency,start_date) values($1,$2,'expense',10000,$3,$4,'monthly',$5)",
      [skipRule, `Cemig pular ${width}`, cash, expense, today],
    );
    await page.setViewportSize({ width, height: 844 });
    await page.reload();
    await page.getByText("Posição líquida agora", { exact: true }).waitFor();
    await nav("Planejar").click();
    await tab("Visão do mês").click();
    await page
      .locator("summary")
      .filter({ hasText: /^Fixas/ })
      .click();
    const paidRow = page
      .locator(".commitment-row")
      .filter({ hasText: "Cemig hotfix quitada" });
    await paidRow.getByText("Realizado", { exact: true }).waitFor();
    assert.equal(await paidRow.getByRole("button").count(), 0);
    assert.equal(
      (await paidRow.innerText()).includes("conta de reserva"),
      false,
    );
    assert.equal(
      (await paidRow.innerText()).includes("transferência interna"),
      false,
    );
    assert.ok((await paidRow.innerText()).includes("363,37"));
    await fit(`${width}px Cemig quitada sem residual nem rótulo interno`);
    const partialRow = page
      .locator(".commitment-row")
      .filter({ hasText: `Cemig parcial ${width}` });
    await partialRow
      .getByRole("button", { name: "Marcar pago", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Realizar ou pular ocorrência" })
      .waitFor();
    assert.equal(await field("Valor pago (R$)").inputValue(), "50,00");
    await fit(`${width}px pagamento parcial por regra canônica`);
    await save();
    await partialRow.getByText("Realizado", { exact: true }).waitFor();
    assert.equal(await partialRow.getByRole("button").count(), 0);
    const beforeSkip = await query(
      "select id,amount_cents,status,transaction_date from transactions order by id",
    );
    const skipRow = page
      .locator(".commitment-row")
      .filter({ hasText: `Cemig pular ${width}` });
    await skipRow
      .getByRole("button", { name: "Marcar pago", exact: true })
      .click();
    await field("Ação").selectOption("skip");
    await fit(`${width}px pular ocorrência sem pagamento`);
    await save();
    assert.deepEqual(
      await query(
        "select id,amount_cents,status,transaction_date from transactions order by id",
      ),
      beforeSkip,
    );
    assert.equal(
      (
        await query(
          "select status from recurring_occurrences where recurring_item_id=$1",
          [skipRule],
        )
      )[0].status,
      "skipped",
    );
    await tab("Recorrentes").click();
    const ruleCard = page.locator("article").filter({
      has: page.getByRole("heading", {
        name: "Cemig hotfix quitada",
        exact: true,
      }),
    });
    await ruleCard
      .getByRole("button", { name: "Ajustar previsão", exact: true })
      .first()
      .click();
    await field("Valor (R$)").fill("396,78");
    await fit(`${width}px previsão variável do próximo mês`);
    await save();
    assert.deepEqual(
      await query(
        "select id,amount_cents,status,transaction_date from transactions order by id",
      ),
      beforeSkip,
    );
    await tab("Investimentos e reserva").click();
    assert.equal(
      await page.getByText("Reserva hotfix excluída", { exact: true }).count(),
      0,
    );
    await page.getByText("Caixinha Turbo hotfix", { exact: true }).waitFor();
    await button("Ajustar reserva").click();
    assert.equal(
      await page.getByLabel("Reserva hotfix excluída", { exact: true }).count(),
      0,
    );
    await fit(
      `${width}px reserva aposentada ausente e nova Caixinha preservada`,
    );
    await button("Fechar").click();
    await capture(`${width}-hotfix-reserva-cemig`);
  }

  // Subscription flow uses actual RPCs against this disposable PostgreSQL.
  const subscriptionBankBefore = await actualCash();
  await nav("Carteira").click();
  await tab("Cartões").click();
  await button("Adicionar cartão").click();
  await field("Nome").fill("Cartão de assinaturas local");
  await field("Dia do fechamento").fill("20");
  await field("Dia do vencimento").fill("28");
  await save();
  const subscriptionCard = (
    await query(
      "select id from credit_cards where name='Cartão de assinaturas local'",
    )
  )[0].id;
  await tab("Assinaturas").click();
  await button("Adicionar assinatura").click();
  assert.equal(await field("Cartão").inputValue(), "");
  await field("Nome").fill("Assinatura local");
  await field("Cartão").selectOption(subscriptionCard);
  await field("Categoria").selectOption(expense);
  await field("Valor previsto (R$)").fill("20,00");
  await field("Dia habitual da cobrança").fill(
    String(Number(today.slice(8, 10))),
  );
  await field("Data inicial").fill(today);
  await save();
  assert.equal(await actualCash(), subscriptionBankBefore);
  const subscription = (await query("select id from card_subscriptions"))[0].id;
  await button("Alterar próximas cobranças").click();
  const nextMonth = new Date(today + "T12:00:00Z");
  nextMonth.setUTCDate(1);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  await field("Aplicar a partir do mês de cobrança").fill(
    nextMonth.toISOString().slice(0, 7),
  );
  await field("Valor previsto (R$)").fill("25,00");
  await save();
  await button("Conferir cobrança").click();
  await field("Valor previsto (R$)").fill("21,00");
  await save();
  await button("Conferir cobrança").click();
  await field("Ação").selectOption("confirm");
  await save();
  assert.equal(
    (
      await query(
        "select * from card_subscription_occurrences where subscription_id=$1",
        [subscription],
      )
    )[0].status,
    "confirmed",
  );
  assert.equal(
    (
      await query("select * from card_purchases where card_id=$1", [
        subscriptionCard,
      ])
    ).length,
    1,
  );
  assert.equal(await actualCash(), subscriptionBankBefore);
  await tab("Cartões").click();
  const subscriptionCardPanel = page.locator("article").filter({
    has: page.getByRole("heading", {
      name: "Cartão de assinaturas local",
      exact: true,
    }),
  });
  await subscriptionCardPanel
    .getByRole("button", { name: "Pagar fatura", exact: true })
    .click();
  assert.equal(await field("Valor (R$)").inputValue(), "21,00");
  await save();
  assert.equal(await actualCash(), subscriptionBankBefore - 2100);
  const confirmedLedger = await query("select * from transactions order by id");
  await tab("Assinaturas").click();
  await button("Conferir cobrança").waitFor({ state: "hidden" });
  assert.deepEqual(
    await query("select * from transactions order by id"),
    confirmedLedger,
  );
  results.push(
    "subscription registration, future price, one-occurrence override, confirmed purchase and invoice payment use real isolated RPCs; forecasts never debit cash",
  );

  // Cheque especial: ordinary daily flows against the actual isolated ledger.
  await nav("Carteira").click();
  await tab("Contas").click();
  await button("+ Criar").click();
  await field("Nome").fill("Itaú cheque sintético");
  await field("Saldo atual (R$)").fill("0,00");
  await save();
  const itau = (
    await query("select id from accounts where name='Itaú cheque sintético'")
  )[0].id;
  const accountPanel = page
    .locator("details.settings-account")
    .filter({ hasText: "Itaú cheque sintético" });
  await accountPanel.locator(":scope > summary").first().click();
  await accountPanel
    .getByRole("button", { name: "Habilitar cheque especial" })
    .click();
  await field("Limite contratado (R$)").fill("1000,00");
  await field("Início do acompanhamento").fill(today);
  await field("Representação no extrato").selectOption("negative_balance");
  await field("Referência ou motivo da configuração").fill(
    "Contrato sintético para validação",
  );
  await save();
  await quick("Despesa");
  await field("Conta").selectOption(itau);
  await field("Categoria").selectOption(expense);
  await field("Valor (R$)").fill("300,00");
  await save();
  const accountBalance = async () =>
    Number(
      (
        await query(
          "select a.initial_balance_cents+coalesce(sum(case when t.type='income' then t.amount_cents when t.type='adjustment' then t.adjustment_delta_cents else -t.amount_cents end),0) b from accounts a left join transactions t on t.account_id=a.id and t.status='realized' and t.transaction_date<=financial_date() where a.id=$1 group by a.id",
          [itau],
        )
      )[0].b,
    );
  assert.equal(await accountBalance(), -30000);
  await nav("Carteira").click();
  await tab("Contas").click();
  if (
    !(await accountPanel
      .locator(":scope > summary")
      .first()
      .evaluate((el) => el.parentElement.open))
  )
    await accountPanel.locator(":scope > summary").first().click();
  await accountPanel.getByText("Em uso", { exact: true }).waitFor();
  assert.equal(
    await accountPanel.getByRole("progressbar").getAttribute("value"),
    "30",
  );
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await accountPanel.getByText("Histórico de utilização por data").click();
    assert.equal(
      (await accountPanel.innerText()).includes("[object Object]"),
      false,
    );
    await fit(`${width}px cheque especial daily history`);
    await capture(`overdraft-${width}`);
    await accountPanel.getByText("Histórico de utilização por data").click();
  }
  await accountPanel
    .getByRole("button", { name: "Conferir extrato bancário" })
    .click();
  await field("Saldo bancário no extrato (R$)").fill("-350,00");
  await field("Referência do extrato e explicação").fill(
    "Extrato sintético, diferença a investigar",
  );
  await button("Conferir diferença").click();
  await page
    .getByLabel("Conferi o extrato e confirmo o registro desta diferença")
    .check();
  await button("Confirmar conferência").click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await accountBalance(), -30000);
  assert.equal(
    Number(
      (
        await query(
          "select difference_cents from bank_reconciliations where account_id=$1",
          [itau],
        )
      )[0].difference_cents,
    ),
    -5000,
  );
  await quick("Despesa");
  await field("Conta").selectOption(itau);
  await field("Categoria").selectOption(expense);
  await field("Valor (R$)").fill("10,00");
  await field("Identificação do encargo (opcional)").selectOption(
    "overdraft_interest",
  );
  await save();
  assert.equal(await accountBalance(), -31000);
  await quick("Receita");
  await field("Conta").selectOption(itau);
  const incomeCat = (
    await query("select id from categories where type='income' limit 1")
  )[0].id;
  await field("Categoria").selectOption(incomeCat);
  await field("Valor (R$)").fill("200,00");
  await save();
  assert.equal(await accountBalance(), -11000);
  results.push(
    "overdraft configuration, debit crossing zero, derived usage, explicit non-mutating reconciliation, charged interest and receipt recovery through isolated RPCs",
  );

  await nav("Início").click();
  await button("Ocultar valores").click();
  assert.equal(
    await page
      .locator("main")
      .innerText()
      .then((s) => s.includes("R$")),
    false,
  );
  await nav("Planejar").click();
  await tab("Cartões").click();
  await button("Editar cartão").first().click();
  assert.equal(
    await field("Limite (R$) · opcional").getAttribute("type"),
    "password",
  );
  await button("Fechar").click();
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  await writeFile(
    "test-results/mobile/report.json",
    JSON.stringify(
      {
        passed: results.length,
        checks: results,
        errors,
        outbound,
        backend:
          "PGlite com RLS authenticated e migrations 001–016; Auth e HTTP simulados; nenhum acesso remoto",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        passed: results.length,
        errors,
        outbound,
        screenshots: "test-results/mobile",
      },
      null,
      2,
    ),
  );
} catch (error) {
  await mkdir("test-results/mobile", { recursive: true });
  if (activePage) {
    await activePage.screenshot({
      path: "test-results/mobile/failure.png",
      fullPage: true,
    });
    console.error(await activePage.locator("body").innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await db.close();
}
