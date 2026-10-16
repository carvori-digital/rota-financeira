// Real Auth + PostgREST + PostgreSQL, bound to localhost with synthetic users.
// Never reads application .env files or connects to a remote financial database.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  open,
} from "node:fs/promises";
import { randomBytes, randomUUID as id, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
const exec = promisify(execFile);
const bin = resolve(
  process.env.PG_TEST_BIN ?? "test-results/pg17-runtime/pgsql/bin",
);
const authBin = resolve(
  process.env.AUTH_TEST_BIN ?? "test-results/release-runtime/auth.exe",
);
const restBin = resolve(
  process.env.POSTGREST_TEST_BIN ?? "test-results/postgrest14/postgrest.exe",
);
const pgModule = await import(
  pathToFileURL(
    resolve(
      process.env.PG_TEST_MODULE ??
        "test-results/audit/tools/node_modules/pg/lib/index.js",
    ),
  ).href
);
const { Client } = pgModule.default ?? pgModule;
await mkdir("test-results/release", { recursive: true });
const root = await mkdtemp(resolve("test-results/release/native-"));
const password = randomBytes(24).toString("hex"),
  secret = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  PATH: bin + (process.platform === "win32" ? ";" : ":") + process.env.PATH,
};
const exe = (name) =>
  resolve(bin, name + (process.platform === "win32" ? ".exe" : ""));
const sign = (payload) => {
  const head = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }),
  ).toString("base64url");
  return (
    head +
    "." +
    body +
    "." +
    createHmac("sha256", secret)
      .update(head + "." + body)
      .digest("base64url")
  );
};
const checks = [],
  children = [],
  logs = [],
  clients = [];
let started = false,
  db,
  proxy,
  loseResponse = false;
const check = (label) => {
  checks.push(label);
  console.log("PASS " + label);
};
const start = async (file, args, vars, label, cwd = root) => {
  const log = await open(root + "/" + label + ".log", "w", 0o600);
  logs.push(log);
  const child = spawn(file, args, {
    cwd,
    env: vars,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  children.push(child);
  child.on("error", () => {});
  return child;
};
const waitReady = async (url, child) => {
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null)
      throw Error("Local service exited; inspect private logs: " + root);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      // Startup connection failures are expected until the listener is ready.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("Local service startup timed out: " + url);
};
const ok = async (request) => {
  const r = await request;
  if (r.error) throw Error("Isolated API failed: " + r.error.message);
  return r.data;
};
try {
  await exec(
    exe("initdb"),
    [
      "-D",
      root + "/data",
      "-U",
      "postgres",
      "--auth=trust",
      "--no-locale",
      "-E",
      "UTF8",
    ],
    { env, timeout: 60000, windowsHide: true },
  );
  await exec(
    exe("pg_ctl"),
    [
      "-D",
      root + "/data",
      "-l",
      root + "/server.log",
      "-o",
      "-p 55491 -h 127.0.0.1",
      "-w",
      "start",
    ],
    { env, timeout: 60000, windowsHide: true },
  );
  started = true;
  db = new Client({
    host: "127.0.0.1",
    port: 55491,
    user: "postgres",
    database: "postgres",
    statement_timeout: 15000,
  });
  await db.connect();
  await db.query(`create role anon; create role authenticated; create role service_role bypassrls;
    create role authenticator login noinherit password '${password}';
    grant anon,authenticated,service_role to authenticator;
    create schema auth; create schema extensions;
    create extension if not exists pgcrypto with schema extensions;
    create function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;`);
  const authEnv = {
    ...env,
    GOTRUE_JWT_SECRET: secret,
    GOTRUE_JWT_EXP: "3600",
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_DB_DRIVER: "postgres",
    DB_NAMESPACE: "auth",
    DATABASE_URL:
      "postgres://postgres@127.0.0.1:55491/postgres?sslmode=disable&search_path=auth,public,extensions",
    GOTRUE_DB_DATABASE_URL:
      "postgres://postgres@127.0.0.1:55491/postgres?sslmode=disable&search_path=auth,public,extensions",
    API_EXTERNAL_URL: "http://127.0.0.1:55492",
    GOTRUE_API_HOST: "127.0.0.1",
    GOTRUE_API_PORT: "55492",
    PORT: "55492",
    GOTRUE_SITE_URL: "http://127.0.0.1:55494",
    GOTRUE_MAILER_AUTOCONFIRM: "true",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
    GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
    GOTRUE_DISABLE_SIGNUP: "false",
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "100",
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true",
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: "10",
    GOTRUE_LOG_LEVEL: "warn",
  };
  const auth = await start(
    authBin,
    [],
    authEnv,
    "auth",
    resolve("test-results/release-runtime/auth-2.197.0"),
  );
  await waitReady("http://127.0.0.1:55492/health", auth);
  check("Supabase Auth real starts with its own auth schema migrations");
  const files = (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files.filter((f) => f < "202610150013"))
    await db.query(await readFile("supabase/migrations/" + f, "utf8"));
  await db.query(
    "create or replace function public.financial_date() returns date language sql stable as $$select date '2026-10-15'$$",
  );
  await writeFile(
    root + "/postgrest.conf",
    `db-uri = "postgresql://authenticator:${password}@127.0.0.1:55491/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = 55493\njwt-secret = "${secret}"\n`,
    { mode: 0o600 },
  );
  const rest = await start(
    restBin,
    [root + "/postgrest.conf"],
    env,
    "postgrest",
  );
  await waitReady("http://127.0.0.1:55493/", rest);
  proxy = createServer(async (req, res) => {
    try {
      const isAuth = req.url.startsWith("/auth/v1/");
      const prefix = isAuth ? "/auth/v1" : "/rest/v1";
      if (!req.url.startsWith(prefix + "/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const data = [];
      for await (const chunk of req) data.push(chunk);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      delete headers.connection;
      const upstream = await fetch(
        `http://127.0.0.1:${isAuth ? 55492 : 55493}` +
          req.url.slice(prefix.length),
        {
          method: req.method,
          headers,
          ...(data.length ? { body: Buffer.concat(data) } : {}),
          signal: AbortSignal.timeout(15000),
        },
      );
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (
        loseResponse &&
        req.url.includes("/rpc/create_financial_transaction")
      ) {
        loseResponse = false;
        res.destroy();
        return;
      }
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(bytes);
    } catch {
      if (!res.destroyed) {
        res.writeHead(502);
        res.end("{}");
      }
    }
  });
  await new Promise((r) => proxy.listen(55494, "127.0.0.1", r));
  const base = "http://127.0.0.1:55494",
    anon = sign({ role: "anon" }),
    service = sign({ role: "service_role" });
  const admin = createClient(base, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  clients.push(admin);
  for (const letter of ["a", "b"]) {
    const email = `release-${id()}-${letter}@example.test`,
      pass = randomBytes(24).toString("base64url");
    await ok(
      admin.auth.admin.createUser({
        email,
        password: pass,
        email_confirm: true,
      }),
    );
    const client = createClient(base, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clients.push(client);
    await ok(client.auth.signInWithPassword({ email, password: pass }));
  }
  const [, a, b] = clients;
  const userA = (await a.auth.getUser()).data.user.id,
    userB = (await b.auth.getUser()).data.user.id;
  assert.notEqual(userA, userB);
  check(
    "two synthetic users log in through real Auth and receive usable sessions",
  );
  const account = await ok(
    a
      .from("accounts")
      .insert({
        name: "Synthetic release cash",
        type: "checking",
        initial_balance_cents: 100000,
      })
      .select()
      .single(),
  );
  const categories = await ok(a.from("categories").select("id,type")),
    expense = categories.find((c) => c.type === "expense").id,
    income = categories.find((c) => c.type === "income").id;
  assert.equal(
    (await ok(b.from("accounts").select("id").eq("id", account.id))).length,
    0,
  );
  assert.equal(
    (
      await ok(
        b
          .from("accounts")
          .update({ name: "forged" })
          .eq("id", account.id)
          .select(),
      )
    ).length,
    0,
  );
  check("PostgREST uses authenticated SQL role and isolates A/B through RLS");
  const beforeNewRpc = await a.rpc("create_financial_transaction", {
    p_id: id(),
    p_payload: {},
  });
  assert.equal(beforeNewRpc.error?.code, "PGRST202");
  for (const f of files.filter((f) => f >= "202610150013"))
    await db.query(await readFile("supabase/migrations/" + f, "utf8"));
  let schemaReady = false;
  for (let n = 0; n < 40; n++) {
    const r = await a.from("debt_payment_allocations").select("id");
    if (!r.error) {
      schemaReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(schemaReady);
  check(
    "013 + 014 apply in order with real Auth users; PostgREST schema cache reloads",
  );
  const payload = {
    type: "expense",
    account_id: account.id,
    category_id: expense,
    destination_account_id: null,
    amount_cents: 1000,
    description: "Synthetic retry",
    transaction_date: "2026-10-15",
    status: "realized",
    is_recurring: false,
    recurrence_frequency: null,
  };
  const request = id();
  loseResponse = true;
  assert.ok(
    (
      await a.rpc("create_financial_transaction", {
        p_id: request,
        p_payload: payload,
      })
    ).error,
  );
  await ok(
    a.rpc("create_financial_transaction", {
      p_id: request,
      p_payload: payload,
    }),
  );
  assert.equal(
    (await ok(a.from("transactions").select("id").eq("id", request))).length,
    1,
  );
  assert.ok(
    (
      await a.rpc("create_financial_transaction", {
        p_id: request,
        p_payload: { ...payload, amount_cents: 2000 },
      })
    ).error,
  );
  assert.ok(
    (
      await b.rpc("create_financial_transaction", {
        p_id: request,
        p_payload: payload,
      })
    ).error,
  );
  check(
    "lost HTTP response + exact retry has one ledger row; altered payload/foreign replay rejected",
  );
  await ok(
    a
      .from("transactions")
      .update({ amount_cents: 1200 })
      .eq("id", request)
      .select(),
  );
  await ok(a.from("transactions").delete().eq("id", request).select());
  assert.ok(
    (
      await ok(a.from("financial_audit").select("action").eq("row_id", request))
    ).some((r) => r.action === "DELETE"),
  );
  check(
    "ordinary edit/delete through Data API keeps append-only financial history",
  );
  const rule = await ok(
    a
      .from("recurring_items")
      .insert({
        name: "Synthetic recurring",
        type: "expense",
        amount_cents: 10000,
        account_id: account.id,
        category_id: expense,
        frequency: "monthly",
        start_date: "2026-10-15",
      })
      .select()
      .single(),
  );
  await ok(
    a.rpc("set_recurring_occurrence_amount", {
      p_rule: rule.id,
      p_due: "2026-10-15",
      p_amount: 10000,
    }),
  );
  const first = id();
  await ok(
    a.rpc("record_recurring_payment", {
      p_id: first,
      p_rule: rule.id,
      p_due: "2026-10-15",
      p_amount: 4000,
      p_date: "2026-10-15",
    }),
  );
  await ok(
    a
      .from("recurring_items")
      .update({ type: "income", category_id: income, amount_cents: 20000 })
      .eq("id", rule.id)
      .select(),
  );
  await ok(
    a.rpc("record_recurring_payment", {
      p_id: id(),
      p_rule: rule.id,
      p_due: "2026-10-15",
      p_amount: 6000,
      p_date: "2026-10-15",
    }),
  );
  assert.ok(
    (
      await a
        .from("transactions")
        .update({ amount_cents: 1000 })
        .eq("id", first)
    ).error,
  );
  const recurring = await ok(
    a.from("transactions").select("type,amount_cents"),
  );
  assert.equal(
    recurring.reduce((s, t) => s + t.amount_cents, 0),
    10000,
  );
  assert.ok(recurring.every((t) => t.type === "expense"));
  check(
    "recurring partial/complement retains frozen terms and protects old payments",
  );
  const debt = await ok(
    a
      .from("debts")
      .insert({
        name: "Synthetic debt",
        original_amount_cents: 30000,
        remaining_amount_cents: 30000,
        installment_amount_cents: 10000,
        next_due_date: "2026-10-15",
        payment_account_id: account.id,
      })
      .select()
      .single(),
  );
  const dp = id();
  await ok(
    a.rpc("pay_debt", {
      p_id: dp,
      p_debt: debt.id,
      p_account: account.id,
      p_amount: 25000,
      p_date: "2026-10-15",
    }),
  );
  const allocations = await ok(
    a
      .from("debt_payment_allocations")
      .select("amount_cents")
      .eq("payment_id", dp)
      .order("scheduled_date"),
  );
  assert.deepEqual(
    allocations.map((r) => r.amount_cents),
    [10000, 10000, 5000],
  );
  check(
    "debt advance allocates three installments with one payment through HTTP RPC",
  );
  const investment = id();
  await ok(
    a.rpc("create_simple_investment", {
      p_id: investment,
      p_payload: {
        name: "Synthetic investment",
        institution: "Local",
        type: "RDB",
        initial_date: "2026-10-15",
        initial_cents: 10000,
        yield_type: "manual",
        yield_rate: 0,
        reserve: true,
        acknowledged: true,
      },
    }),
  );
  await ok(
    a.rpc("simple_investment_movement", {
      p_id: id(),
      p_investment: investment,
      p_type: "contribution",
      p_amount: 1000,
      p_date: "2026-10-15",
      p_account: account.id,
      p_description: "Synthetic contribution",
      p_transfer: null,
      p_expected: 10000,
      p_confirmed: true,
    }),
  );
  const withdrawal = {
    p_id: id(),
    p_investment: investment,
    p_type: "withdrawal",
    p_amount: 500,
    p_date: "2026-10-15",
    p_account: account.id,
    p_description: "Synthetic withdrawal",
    p_transfer: null,
    p_expected: 11000,
    p_confirmed: true,
  };
  await ok(a.rpc("simple_investment_movement", withdrawal));
  await ok(a.rpc("simple_investment_movement", withdrawal));
  check(
    "canonical investment contribution/withdrawal and exact retry work through HTTP",
  );
  assert.ok((await a.rpc("delete_investment", { p_id: investment })).error);
  const privateRoute = await a.rpc("record_investment_movement", {
    p_id: id(),
    p_investment: investment,
    p_type: "withdrawal",
    p_amount: 1,
    p_date: "2026-10-15",
    p_account: account.id,
    p_description: "forbidden",
  });
  assert.ok(privateRoute.error);
  assert.ok(
    (
      await a.from("financial_requests").insert({
        id: id(),
        user_id: userA,
        operation: "forged",
        payload: {},
        result: id(),
      })
    ).error,
  );
  const noAuth = createClient(base, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  clients.push(noAuth);
  assert.ok(
    (
      await noAuth.rpc("create_financial_transaction", {
        p_id: id(),
        p_payload: payload,
      })
    ).error,
  );
  check(
    "legacy routes, evidence writes and unauthenticated financial RPC are denied",
  );
  const session = (await a.auth.getSession()).data.session;
  const expired = sign({
    ...JSON.parse(
      Buffer.from(session.access_token.split(".")[1], "base64url").toString(),
    ),
    exp: 1,
  });
  const expiredResponse = await fetch(base + "/rest/v1/accounts?select=id", {
    headers: { apikey: anon, Authorization: "Bearer " + expired },
  });
  assert.equal(expiredResponse.status, 401);
  await ok(a.auth.refreshSession({ refresh_token: session.refresh_token }));
  assert.equal((await ok(a.auth.getUser())).user.id, userA);
  await ok(a.from("accounts").select("id"));
  check(
    "expired JWT rejected by PostgREST; real Auth refresh restores Data API access",
  );
  const snapshot = await ok(a.rpc("export_financial_snapshot"));
  assert.equal(snapshot.owner, userA);
  for (const rows of Object.values(snapshot.data))
    assert.ok(rows.every((r) => !r.user_id || r.user_id === userA));
  check(
    "real authenticated export keeps tenant ownership across financial modules",
  );
  const report = {
    passed: checks.length,
    checks,
    synthetic: true,
    remote_financial_writes: false,
    host: "127.0.0.1",
    auth: "Supabase Auth v2.197.0 native",
    postgrest: "native",
    postgres: (await db.query("select version() v")).rows[0].v,
  };
  await writeFile(
    "test-results/release/integration.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    "test-results/release/integration-failure.json",
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        error: error.message,
        private_logs: root,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const client of clients) client.auth.stopAutoRefresh();
  if (proxy) await new Promise((r) => proxy.close(r));
  for (const child of children.reverse()) child.kill();
  await db?.end();
  if (started)
    await exec(
      exe("pg_ctl"),
      ["-D", root + "/data", "-m", "immediate", "-w", "stop"],
      { env, timeout: 30000, windowsHide: true },
    );
  for (const log of logs) await log.close();
}
