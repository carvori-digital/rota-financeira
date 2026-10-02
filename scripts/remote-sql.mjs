import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export async function remoteSql(contents, label) {
  if (!process.env.npm_execpath) throw new Error("Execute através de npm run.");
  if (
    (await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
    "lgcozsoenycvifiygdsj"
  )
    throw new Error("Projeto remoto divergente.");
  await mkdir("test-results", { recursive: true });
  const path = "test-results/" + randomUUID() + "-" + label + ".sql";
  await writeFile(path, contents, { mode: 0o600 });
  try {
    const job = exec(
      process.execPath,
      [
        process.env.npm_execpath,
        "exec",
        "--yes",
        "--package=supabase@2.119.0",
        "--",
        "supabase",
        "db",
        "query",
        "--linked",
        "--file",
        path,
      ],
      { timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
    );
    job.child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (
          /^(Initialising login role|Connecting to remote database)/.test(line)
        )
          process.stdout.write(label + ": " + line + "\n");
      }
    });
    const r = await job;
    return JSON.parse(r.stdout);
  } catch (e) {
    const sanitized = (e.stderr ?? "").replace(
      /password[^\n]*/gi,
      "password [oculto]",
    );
    throw new Error(
      "Consulta remota " +
        label +
        " falhou (" +
        (e.killed ? "timeout" : (e.code ?? "erro")) +
        "): " +
        sanitized.slice(-1500),
    );
  } finally {
    await unlink(path).catch(() => {});
  }
}
