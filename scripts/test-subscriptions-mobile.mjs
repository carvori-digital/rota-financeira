// Visual/interaction rehearsal only: explicit synthetic adapter, all remote traffic blocked.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createExperienceServer } from "./experience-preview.mjs";
const server = await createExperienceServer(5177);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/chromium",
});
const context = await browser.newContext({
  viewport: { width: 375, height: 844 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: "reduce",
});
const page = await context.newPage(),
  errors = [],
  outbound = [],
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
const button = (name) => page.getByRole("button", { name, exact: true });
const tab = (name) => page.getByRole("tab", { name, exact: true });
await mkdir("test-results/subscriptions", { recursive: true });
const fit = async (name) => {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll("nav button")].map((b) => ({
      width: b.getBoundingClientRect().width,
      height: b.getBoundingClientRect().height,
      clipped:
        b.querySelector("small").scrollWidth >
        b.querySelector("small").clientWidth,
    })),
    dialog: document
      .querySelector("dialog[open]")
      ?.getBoundingClientRect()
      .toJSON(),
  }));
  assert.ok(dimensions.scroll <= dimensions.width, name + ": page overflow");
  assert.equal(dimensions.buttons.length, 6);
  for (const b of dimensions.buttons) {
    assert.ok(b.width >= 44 && b.height >= 44);
    assert.equal(b.clipped, false);
  }
  if (dimensions.dialog) {
    assert.ok(dimensions.dialog.x >= 0);
    assert.ok(dimensions.dialog.right <= dimensions.width);
  }
  checks.push(name);
};
try {
  await page.goto("http://127.0.0.1:5177", { waitUntil: "domcontentloaded" });
  await page.getByText("Posição líquida agora", { exact: true }).waitFor();
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await nav("Carteira").click();
    for (const name of [
      "Contas",
      "Cartões",
      "Assinaturas",
      "Investimentos e reserva",
      "Dívidas e parcelas",
    ]) {
      await tab(name).click();
      await fit(`${width}px Carteira ${name}`);
    }
    await tab("Assinaturas").click();
    await page
      .getByText("A conferir na fatura informada", { exact: true })
      .waitFor();
    await page.screenshot({
      path: `test-results/subscriptions/${width}-subscriptions.png`,
      fullPage: true,
    });
    await button("Conferir cobrança").click();
    await page.getByLabel("Ação", { exact: true }).selectOption("confirm");
    assert.equal(
      await page
        .getByLabel("Esta cobrança está na fatura informada?")
        .inputValue(),
      "",
    );
    await page
      .getByLabel("Esta cobrança está na fatura informada?")
      .selectOption("included");
    await fit(`${width}px confirmation with manual invoice`);
    await page.screenshot({
      path: `test-results/subscriptions/${width}-confirm.png`,
      fullPage: true,
    });
    await button("Fechar").click();
    assert.equal(
      await button("Conferir cobrança").evaluate(
        (el) => el === document.activeElement,
      ),
      true,
    );
    await button("Adicionar assinatura").click();
    for (const name of [
      "Nome",
      "Cartão",
      "Categoria",
      "Dia habitual da cobrança",
      "Data inicial",
    ])
      assert.equal(
        await page.getByLabel(name, { exact: true }).inputValue(),
        "",
      );
    await fit(`${width}px registration`);
    await button("Fechar").click();
    for (const [label, title] of [
      ["Aportar em investimento", "Aportar"],
      ["Resgatar investimento", "Resgatar"],
    ]) {
      await nav("Novo").click();
      await button(label).click();
      await page.getByRole("dialog", { name: title, exact: true }).waitFor();
      await fit(`${width}px Novo ${label}`);
      await button("Fechar").click();
      assert.equal(
        await tab("Assinaturas").getAttribute("aria-selected"),
        "true",
      );
    }
    await nav("Início").click();
    await button("Planejar").click();
    await page.getByRole("heading", { name: "Planejar meu mês" }).waitFor();
    await fit(`${width}px monthly planning from Home`);
    await button("Voltar ao Início").click();
  }
  await button("Ocultar valores").click();
  await nav("Carteira").click();
  await tab("Assinaturas").click();
  assert.ok(!(await page.locator("main").innerText()).includes("R$"));
  await button("Conferir cobrança").click();
  assert.equal(
    await page.getByLabel("Valor previsto (R$)").getAttribute("type"),
    "password",
  );
  await fit("hidden subscription amounts");
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  const report = {
    passed: checks.length,
    checks,
    errors,
    outbound,
    synthetic: true,
    remote_database: false,
    engine: "Chromium mobile emulation",
    widths: [320, 375, 390, 430],
  };
  await writeFile(
    "test-results/subscriptions/mobile.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
