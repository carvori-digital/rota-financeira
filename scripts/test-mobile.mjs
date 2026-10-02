// Local browser integration: real migrated PostgreSQL, simulated Auth/HTTP,
// and all outbound requests blocked. No remote Supabase or production writes.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
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
  "accounts",
  "categories",
  "transactions",
  "goals",
  "goal_contributions",
  "recurring_items",
  "recurring_occurrences",
  "credit_cards",
  "card_purchases",
  "card_invoices",
  "card_payments",
  "debts",
  "debt_payments",
  "reserve_account_links",
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
          ? value.toISOString().slice(0, key.endsWith("_date") ? 10 : 24)
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
  for (const name of [
    "202610010001_initial.sql",
    "202610010002_planning.sql",
    "202610010003_planning_integrity.sql",
    "202610020004_financial_clarity.sql",
  ])
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
            "set_card_invoice",
            "pay_card_invoice",
            "pay_debt",
            "resolve_recurring",
            "repeat_transaction",
            "save_emergency_reserve",
            "resolve_transaction",
            "adjust_account_balance",
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
    page.getByRole("navigation").getByRole("button", { name, exact: true });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
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
    await nav("Adicionar").click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: true })
      .click();
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
        timeout: 30000,
      });
      break;
    } catch (e) {
      if (attempt === 2 || !e.message.includes("ERR_NETWORK_IO_SUSPENDED"))
        throw e;
      console.log("Chrome retomando rede após suspensão do Windows.");
    }
  }
  await page
    .getByText("Livre depois dos compromissos · mês atual", { exact: true })
    .waitFor({ timeout: 30000 });
  await nav("Planejar").click();
  await tab("Cartões").click();
  await button("Adicionar cartão").first().click();
  await field("Nome").fill("Cartão local");
  await field("Limite (R$) · opcional").fill("2000");
  await field("Dia do fechamento").fill("20");
  await field("Dia do vencimento").fill("28");
  await fit("375px criar cartão");
  await capture("375-card-form");
  await save();
  await button("Editar cartão").click();
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
  await field("Valor (R$)").fill("120");
  await field("Vencimento").fill(`${today.slice(0, 7)}-28`);
  await save();
  await button("Pagar fatura").first().click();
  await field("Valor (R$)").fill("20");
  await save();
  assert.equal(
    Number(
      (await query("select sum(amount_cents) amount from card_payments"))[0]
        .amount,
    ),
    2000,
  );
  await tab("Dívidas / Parcelas").click();
  await button("Adicionar dívida").first().click();
  await field("Nome").fill("Dívida local");
  await field("Dívida original (R$)").fill("300");
  await field("Quanto falta pagar (R$)").fill("250");
  await field("Parcela mensal (R$) · opcional").fill("100");
  await field("Próximo vencimento · opcional").fill(`${today.slice(0, 7)}-28`);
  await save();
  await button("Editar dívida").click();
  await field("Nome").fill("Dívida editada");
  await field("Próximo vencimento · opcional").fill(`${today.slice(0, 7)}-27`);
  await field("Parcela mensal (R$) · opcional").fill("80");
  await save();
  await nav("Início").click();
  await quick("Pagamento de dívida");
  await field("Valor (R$)").fill("30");
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
  await field("Valor (R$)").fill("50");
  await field("Categoria").selectOption(expense);
  await field("Primeira ocorrência").fill(today);
  await field("Despesa essencial").check();
  await save();
  await button("Editar regra").click();
  await field("Valor (R$)").fill("60");
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
  await tab("Investimentos/Reserva").click();
  await button("Ajustar reserva").click();
  await field(
    "Custo essencial mensal (R$) · deixe vazio para usar sugestão",
  ).fill("100");
  await field("Meses de proteção").fill("6");
  await save();
  assert.equal((await query("select * from reserve_account_links")).length, 1);
  await nav("Início").click();
  await quick("Receita");
  await field("Valor (R$)").fill("200");
  await field("Categoria").selectOption({ label: "Salário" });
  await field("Conta").selectOption(cash);
  await save();
  await quick("Despesa");
  await field("Valor (R$)").fill("10");
  await field("Categoria").selectOption(expense);
  await field("Conta").selectOption(reserve);
  await save();
  await quick("Receita");
  assert.equal(await field("Conta").inputValue(), reserve);
  await button("Fechar").click();
  await quick("Transferência");
  await field("Conta de origem").selectOption(cash);
  await field("Conta de destino").selectOption(reserve);
  await field("Valor (R$)").fill("40");
  await save();
  await quick("Aporte/transferência");
  await button("Aportar em Viagem local").click();
  await field("Valor (R$)").fill("25");
  await save();
  assert.equal((await query("select * from goal_contributions")).length, 1);
  // Creating a transaction with recurrence uses the real atomic RPC.
  await quick("Despesa");
  await field("Valor (R$)").fill("5");
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
  await quick("Agendar receita/despesa");
  await field("Descrição").fill("Tarifa programada");
  await field("Valor (R$)").fill("10");
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
  await tab("Visão do mês").click();
  const scheduled = () =>
    page
      .getByRole("tabpanel")
      .locator("article")
      .filter({ hasText: "Tarifa programada" });
  await scheduled()
    .getByRole("button", { name: "Editar programada", exact: true })
    .click();
  await field("Valor (R$)").fill("12");
  await save();
  await scheduled()
    .getByRole("button", { name: "Confirmar / cancelar", exact: true })
    .click();
  await save();
  assert.equal(await actualCash(), beforePending - 1200);
  await quick("Agendar receita/despesa");
  await field("Descrição").fill("Cancelar programada");
  await field("Valor (R$)").fill("10");
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
  await field("Valor por parcela (R$)").fill("100");
  await field("Parcela atual").fill("8");
  await field("Total de parcelas").fill("14");
  await field("Saldo restante conhecido (R$) · opcional").fill("650");
  await field("Próximo vencimento").fill(today.slice(0, 7) + "-31");
  await save();
  await tab("Dívidas / Parcelas").click();
  await page.getByText(/Parcela 8\/14/).waitFor();
  await nav("Ajustes").click();
  await page
    .locator(".settings-row")
    .filter({ hasText: "Conta local" })
    .getByRole("button", { name: "Ajustar saldo atual", exact: true })
    .click();
  await field("Saldo atual correto (R$)").fill("-25");
  await save();
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
    .getByText("Livre depois dos compromissos · mês atual", { exact: true })
    .waitFor();
  results.push(
    "programada vencida não altera caixa; editar; confirmar uma vez; cancelar; parcela 8/14; ajuste negativo rastreável; configuração rápida",
  );
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await nav("Início").click();
    await page
      .getByText("Livre depois dos compromissos · mês atual", { exact: true })
      .waitFor();
    await fit(`${width}px Home`);
    await capture(`${width}-home`);
    await nav("Planejar").click();
    for (const name of [
      "Visão do mês",
      "Próximos meses",
      "Cartões",
      "Dívidas / Parcelas",
      "Recorrentes",
      "Investimentos/Reserva",
    ]) {
      await tab(name).click();
      await fit(`${width}px ${name}`);
      await capture(
        `${width}-${["Próximos meses", "Cartões", "Dívidas / Parcelas", "Recorrentes", "Investimentos/Reserva"].indexOf(name)}`,
      );
    }
    await tab("Cartões").click();
    await button("Compra no cartão").click();
    await fit(`${width}px compra parcelada modal`);
    await button("Fechar").click();
    await tab("Dívidas / Parcelas").click();
    await button("Registrar pagamento").first().click();
    await fit(`${width}px pagamento dívida modal`);
    await button("Fechar").click();
  }
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
  await button("Editar cartão").click();
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
          "PGlite com RLS authenticated e migrations 001+002+003+004; Auth e HTTP simulados; nenhum acesso remoto",
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
