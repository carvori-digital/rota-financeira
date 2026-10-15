// Native PostgreSQL/PostgREST rehearsal. All mutations are localhost only.
// Optional fresh private snapshot is restored into a new disposable cluster.
import {
  readFile,
  writeFile,
  readdir,
  mkdtemp,
  unlink,
  open,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { createHash, randomUUID, randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  bin = resolve(
    process.env.PG_TEST_BIN ?? "test-results/pg17-runtime/pgsql/bin",
  );
const root = await mkdtemp(resolve("test-results/adjust04-pg-")),
  password = randomBytes(24).toString("hex");
const env = {
  ...process.env,
  PGHOST: "127.0.0.1",
  PGPORT: "55442",
  PGUSER: "postgres",
  PGDATABASE: "postgres",
  PGPASSWORD: password,
  PGCONNECT_TIMEOUT: "20",
  PGOPTIONS: "-c timezone=UTC",
};
let started = false,
  http,
  log;
async function sql(contents) {
  const file = root + "/" + randomUUID() + ".sql";
  await writeFile(file, contents, { mode: 0o600 });
  try {
    return (
      await exec(
        bin + "/psql.exe",
        ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--file=" + file],
        { env, timeout: 60000, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      )
    ).stdout.trim();
  } catch (e) {
    await writeFile(root + "/private-error.log", e.stderr ?? e.message, {
      mode: 0o600,
    });
    throw new Error(
      "Local PostgreSQL query failed; private diagnostic: " +
        root +
        "/private-error.log",
    );
  } finally {
    await unlink(file);
  }
}
const q = async (query) =>
  JSON.parse(
    await sql(
      `select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from (${query}) r;`,
    ),
  );
try {
  await writeFile(root + "/pw", password, { mode: 0o600 });
  await exec(
    bin + "/initdb.exe",
    [
      "-D",
      root + "/data",
      "-U",
      "postgres",
      "--auth=scram-sha-256",
      "--pwfile=" + root + "/pw",
      "--encoding=UTF8",
      "--locale=C",
    ],
    { timeout: 60000, windowsHide: true },
  );
  await unlink(root + "/pw");
  await exec(
    bin + "/pg_ctl.exe",
    [
      "-D",
      root + "/data",
      "-l",
      root + "/server.log",
      "-o",
      "-h 127.0.0.1 -p 55442",
      "-w",
      "start",
    ],
    { timeout: 60000, windowsHide: true },
  );
  started = true;
  await sql(
    "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;grant usage on schema public,auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;alter default privileges in schema public grant all on tables to anon,authenticated;alter default privileges in schema public grant all on sequences to anon,authenticated;",
  );
  const migrations = (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  await sql(
    (
      await Promise.all(
        migrations
          .filter((f) => f < "202610140012")
          .map((f) => readFile("supabase/migrations/" + f, "utf8")),
      )
    ).join("\n"),
  );
  let snapshotVerified = false;
  if (process.argv[2]) {
    const path = process.argv[2];
    assert.ok(path.startsWith("test-results/"));
    const bytes = await readFile(path);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      (await readFile(path + ".sha256", "utf8")).trim(),
    );
    const snap = JSON.parse(bytes);
    assert.equal(snap.project, "lgcozsoenycvifiygdsj");
    assert.equal(snap.migrations.length, 11);
    const normalize = (s) => s.replaceAll("\r\n", "\n").trim();
    const functions = await q(
      "select proname name,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and prokind='f'",
    );
    // auth.uid differs only in the local schema; all public definitions must match production.
    assert.equal(functions.length, snap.functions.length);
    for (const f of snap.functions)
      assert.ok(
        functions.some(
          (l) =>
            l.name === f.name &&
            normalize(l.definition) === normalize(f.definition),
        ),
        "Remote function drift: " + f.name,
      );
    const constraints = await q(
      "select conrelid::regclass::text as table,conname name,pg_get_constraintdef(oid) definition from pg_constraint where connamespace='public'::regnamespace",
    );
    assert.equal(constraints.length, snap.constraints.length);
    for (const c of snap.constraints)
      assert.ok(
        constraints.some((l) => isDeepStrictEqual(l, c)),
        "Constraint drift: " + c.name,
      );
    const users = [
      ...new Set(
        Object.values(snap.data)
          .flat()
          .map((r) => r.user_id),
      ),
    ];
    users.forEach((u) => assert.match(u, /^[0-9a-f-]{36}$/));
    const tables = Object.keys(snap.data);
    tables.forEach((t) => assert.match(t, /^[a-z_]+$/));
    await sql(
      "set session_replication_role=replica;" +
        users.map((u) => `insert into auth.users values('${u}');`).join("") +
        tables
          .map(
            (t) =>
              `insert into public.${t} overriding system value select * from jsonb_populate_recordset(null::public.${t},$snapshot$${JSON.stringify(snap.data[t])}$snapshot$::jsonb);`,
          )
          .join("\n") +
        "set session_replication_role=origin;",
    );
    const before = {};
    for (const t of tables)
      before[t] = await q(`select * from public.${t} order by id`);
    await sql(
      await readFile("supabase/migrations/" + migrations.at(-1), "utf8"),
    );
    for (const t of tables) {
      const after = await q(`select * from public.${t} order by id`);
      assert.equal(after.length, before[t].length);
      for (let n = 0; n < after.length; n++)
        for (const [k, v] of Object.entries(before[t][n]))
          assert.deepEqual(
            after[n][k],
            v,
            "Preexisting field changed: " + t + "." + k,
          );
    }
    assert.equal((await q("select * from investment_operations")).length, 0);
    snapshotVerified = true;
  } else
    await sql(
      await readFile("supabase/migrations/" + migrations.at(-1), "utf8"),
    );
  const a = randomUUID(),
    b = randomUUID(),
    cash = randomUUID(),
    inv = randomUUID();
  await sql(
    `insert into auth.users values('${a}'),('${b}');insert into public.accounts(id,user_id,name,type,initial_balance_cents) values('${cash}','${a}','Synthetic native cash','checking',50000);`,
  );
  const secret = randomBytes(32).toString("hex");
  await writeFile(
    root + "/postgrest.conf",
    `db-uri = "postgresql://postgres:${password}@127.0.0.1:55442/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = 55443\njwt-secret = "${secret}"\n`,
    { mode: 0o600 },
  );
  log = await open(root + "/http.log", "w", 0o600);
  http = spawn(
    resolve(
      process.env.POSTGREST_TEST_BIN ??
        "test-results/postgrest14/postgrest.exe",
    ),
    [root + "/postgrest.conf"],
    {
      env: { ...process.env, PATH: bin + ";" + process.env.PATH },
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  const jwt = (u) => {
    const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
      p = Buffer.from(
        JSON.stringify({
          sub: u,
          role: "authenticated",
          exp: Math.floor(Date.now() / 1000) + 1800,
        }),
      ).toString("base64url");
    return (
      h +
      "." +
      p +
      "." +
      createHmac("sha256", secret)
        .update(h + "." + p)
        .digest("base64url")
    );
  };
  const api = async (name, u, body, method = "POST") => {
    const r = await fetch("http://127.0.0.1:55443/" + name, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(u ? { Authorization: "Bearer " + jwt(u) } : {}),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(20000),
    });
    return { status: r.status, value: await r.json().catch(() => null) };
  };
  let ready = false;
  for (let n = 0; n < 160; n++) {
    try {
      if (
        (
          await fetch("http://127.0.0.1:55443/", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for local schema cache. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, "Local PostgREST schema cache readiness");
  const day = (await q("select financial_date()::text as financial_day"))[0]
    .financial_day;
  const create = {
    p_id: inv,
    p_payload: {
      name: "Synthetic Caixinha",
      institution: "Synthetic",
      type: "RDB",
      initial_date: day,
      yield_type: "percent_cdi",
      yield_rate: 115,
      reserve: true,
      initial_cents: 50000,
      acknowledged: true,
    },
  };
  const created = await Promise.all([
    api("rpc/create_simple_investment", a, create),
    api("rpc/create_simple_investment", a, create),
  ]);
  assert.ok(created.every((r) => r.status === 200));
  const request = randomUUID(),
    movement = {
      p_id: request,
      p_investment: inv,
      p_type: "contribution",
      p_amount: 10000,
      p_date: day,
      p_account: cash,
      p_description: "Synthetic only",
      p_transfer: null,
      p_expected: 50000,
      p_confirmed: true,
    };
  const race = await Promise.all([
    api("rpc/simple_investment_movement", a, movement),
    api("rpc/simple_investment_movement", a, movement),
  ]);
  assert.ok(
    race.every((r) => r.status === 200),
    JSON.stringify(race),
  );
  assert.equal(
    (await api("rpc/investment_value", a, { p_investment: inv, p_date: day }))
      .value,
    60000,
  );
  assert.equal(
    (
      await q(
        `select count(*)::int n from public.transactions where id='${request}'`,
      )
    )[0].n,
    1,
  );
  const different = await Promise.all([
    api("rpc/simple_investment_movement", a, {
      ...movement,
      p_id: randomUUID(),
      p_expected: 60000,
      p_type: "withdrawal",
      p_amount: 40000,
    }),
    api("rpc/simple_investment_movement", a, {
      ...movement,
      p_id: randomUUID(),
      p_expected: 60000,
      p_type: "withdrawal",
      p_amount: 40000,
    }),
  ]);
  assert.equal(different.filter((r) => r.status === 200).length, 1);
  assert.equal(
    (await api("rpc/investment_value", a, { p_investment: inv, p_date: day }))
      .value,
    20000,
  );
  assert.ok(
    (
      await api("rpc/simple_investment_movement", b, {
        ...movement,
        p_id: randomUUID(),
      })
    ).status >= 400,
  );
  assert.deepEqual((await api("investments", b, null, "GET")).value, []);
  assert.ok(
    (await api("rpc/create_simple_investment", null, create)).status >= 400,
  );
  for (const table of ["investment_operations", "investment_movements"])
    assert.ok((await api(table, a, {})).status >= 400);
  const remove = {
    p_request: randomUUID(),
    p_investment: inv,
    p_expected: 20000,
    p_confirmed: true,
  };
  const txBefore = await q(
    `select * from transactions where user_id='${a}' order by id`,
  );
  const deletions = await Promise.all([
    api("rpc/delete_simple_investment", a, remove),
    api("rpc/delete_simple_investment", a, remove),
  ]);
  assert.ok(
    deletions.every((r) => [200, 204].includes(r.status)),
    JSON.stringify(deletions),
  );
  assert.deepEqual(
    await q(`select * from transactions where user_id='${a}' order by id`),
    txBefore,
  );
  const report = {
    engine: "Native PostgreSQL 17 + PostgREST 14",
    localhostOnly: true,
    syntheticMutationsOnly: true,
    freshSnapshotVerified: snapshotVerified,
    allPreexistingFieldsPreserved: snapshotVerified,
    concurrentCreateSinglePosition: true,
    concurrentRetrySingleCashEntry: true,
    concurrentDistinctWithdrawalsStaleGuard: true,
    concurrentDeleteIdempotent: true,
    bankTransactionsPreserved: true,
    tenantIsolation: true,
    anonDenied: true,
    genericWritesDenied: true,
  };
  await writeFile(
    "test-results/adjust04-native-report.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  if (http) {
    http.kill();
    await new Promise((r) => http.once("exit", r));
  }
  if (log) await log.close();
  if (started)
    await exec(
      bin + "/pg_ctl.exe",
      ["-D", root + "/data", "-m", "fast", "-w", "stop"],
      { timeout: 30000, windowsHide: true },
    ).catch(() => {});
  await unlink(root + "/postgrest.conf").catch(() => {});
  delete env.PGPASSWORD;
}
