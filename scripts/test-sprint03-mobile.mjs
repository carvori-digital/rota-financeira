import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createExperienceServer } from "./experience-preview.mjs";
const server = await createExperienceServer(5177),
  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? "/usr/bin/chromium",
    headless: true,
  });
const context = await browser.newContext({
    viewport: { width: 375, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
    acceptDownloads: true,
  }),
  page = await context.newPage(),
  outbound = [],
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === "127.0.0.1" && u.port === "5177") await route.continue();
  else {
    outbound.push(u.origin);
    await route.abort();
  }
});
const nav = (name) =>
  page.getByRole("navigation").getByRole("button", { name, exact: true });
const fit = async (name) => {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    name,
  );
  checks.push(name);
};
await mkdir("test-results/sprint03", { recursive: true });
try {
  await page.goto("http://127.0.0.1:5177");
  await page.getByText("Posição prevista no fim do mês", { exact: true }).waitFor();
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await nav("Relatórios").click();
    await page.getByText("Exportar relatório", { exact: true }).click();
    await fit(`${width} export controls`);
    assert.equal(
      await page.getByLabel("Incluir movimentações detalhadas").isChecked(),
      false,
    );
    await page
      .getByRole("button", { name: "Visualizar resumo antes de exportar" })
      .click();
    await page.getByText("Prévia do relatório", { exact: true }).waitFor();
    await fit(`${width} export preview`);
    for (const ext of ["PDF", "CSV", "JSON"]) {
      const pending = page.waitForEvent("download");
      await page
        .getByRole("button", { name: `Baixar ${ext}`, exact: true })
        .click();
      const download = await pending;
      const path = await download.path(),
        bytes = await readFile(path);
      assert.ok(bytes.length > 50);
      assert.ok(download.suggestedFilename().endsWith("." + ext.toLowerCase()));
      if (ext === "PDF")
        assert.ok(bytes.toString("latin1").startsWith("%PDF-"));
      if (ext === "JSON") {
        const json = JSON.parse(bytes.toString());
        assert.equal(json.mode, "summary");
        assert.equal(json.details, undefined);
      }
      if (ext === "CSV")
        assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
      checks.push(`${width} ${ext} local download`);
    }
    await page.getByLabel("Incluir movimentações detalhadas").check();
    await page
      .getByRole("button", { name: "Visualizar resumo antes de exportar" })
      .click();
    await page.getByText("Prévia do relatório", { exact: true }).waitFor();
    const pending = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Baixar JSON", exact: true })
      .click();
    const download = await pending;
    const json = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.ok(json.details.transactions.length > 0);
    assert.ok(!JSON.stringify(json).includes("preview@local.invalid"));
    await page.screenshot({
      path: `test-results/sprint03/${width}-export.png`,
      fullPage: true,
    });
    await nav("Planejar").click();
    await page
      .getByRole("tab", { name: "Reserva e investimentos", exact: true })
      .click();
    await page.getByText("Valor real e histórico", { exact: true }).click();
    await page
      .getByRole("button", { name: "Reconstruir investimento", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Instituição", { exact: true }).fill("Nubank");
    await dialog
      .getByLabel("Produto", { exact: true })
      .fill("RDB / Caixinha Turbo");
    const date = await dialog
      .getByLabel("Data inicial", { exact: true })
      .inputValue();
    await dialog
      .getByLabel("Aportes e resgates históricos", { exact: true })
      .fill(`${date};aporte;2400,00`);
    await dialog
      .getByLabel("Valor real atual no banco (R$)", { exact: true })
      .fill("2450,00");
    await dialog
      .getByLabel("Referência da reconciliação", { exact: true })
      .fill("Fixture de extrato; diferença informada");
    await fit(`${width} reconstruction form`);
    await dialog
      .getByRole("button", { name: "Preparar reconciliação", exact: true })
      .click();
    await dialog
      .getByText("Diferença de patrimônio", { exact: true })
      .waitFor();
    await fit(`${width} reconciliation preview`);
    await page.screenshot({
      path: `test-results/sprint03/${width}-reconciliation.png`,
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  console.log(
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors,
        outbound,
        screenshots: "test-results/sprint03",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
