import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createExperienceServer } from "./experience-preview.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const server = await createExperienceServer(5176);
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
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
  const url = new URL(route.request().url());
  if (url.hostname === "127.0.0.1" && url.port === "5176")
    await route.continue();
  else {
    outbound.push(url.origin);
    await route.abort();
  }
});
const nav = (name) =>
  page.getByRole("navigation").getByRole("button", { name, exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
await mkdir("test-results/experience", { recursive: true });
const capture = async (name) =>
  page.screenshot({
    path: `test-results/experience/${name}.png`,
    fullPage: true,
  });
const fit = async (name) => {
  const r = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    nav: [...document.querySelectorAll("nav button")].map((b) => {
      const r = b.getBoundingClientRect(),
        l = b.querySelector("small");
      return {
        left: r.left,
        right: r.right,
        height: r.height,
        width: r.width,
        clipped: l.scrollWidth > l.clientWidth,
      };
    }),
  }));
  assert.ok(r.scroll <= r.width, `${name}: horizontal overflow`);
  assert.equal(r.nav.length, 6);
  r.nav.forEach((b, i) => {
    assert.ok(b.width >= 44 && b.height >= 44);
    assert.ok(!b.clipped);
    if (i) assert.ok(b.left >= r.nav[i - 1].right - 1);
  });
  checks.push(name);
};
try {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto("http://127.0.0.1:5176", {
        waitUntil: "domcontentloaded",
      });
      break;
    } catch (e) {
      if (attempt === 2 || !e.message.includes("ERR_NETWORK_IO_SUSPENDED"))
        throw e;
    }
  }
  await page.getByText("Livre no mês", { exact: true }).waitFor();
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await nav("Início").click();
    await fit(`${width}px Home/nav`);
    await capture(`${width}-home`);
    assert.equal(await page.locator(".upcoming-row").count(), 3);
    const projected = await page.locator(".month-hero h2").innerText();
    await nav("Relatórios").click();
    await fit(`${width}px Reports`);
    await capture(`${width}-reports`);
    for (const title of [
      "Fluxo do mês",
      "Gastos por categoria",
      "Evolução mensal",
      "Compromissos",
      "Projeção",
      "Dívidas",
      "Taxa de economia",
    ])
      assert.equal(
        await page.getByRole("heading", { name: title, exact: true }).count(),
        1,
      );
    assert.equal(
      await page
        .getByRole("group", {
          name: "Saldo projetado nos próximos quatro meses",
        })
        .locator(".chart-label strong")
        .first()
        .innerText(),
      projected,
    );
    await nav("Planejar").click();
    for (const title of [
      "Visão do mês",
      "Cartões",
      "Dívidas e parcelas",
      "Recorrentes",
      "Programadas",
      "Reserva e investimentos",
      "Metas",
    ]) {
      await page.getByRole("tab", { name: title, exact: true }).click();
      await fit(`${width}px Planning ${title}`);
    }
    await capture(`${width}-goals`);
    await nav("Movimentos").click();
    await fit(`${width}px Movements`);
    assert.equal(await page.getByLabel("Mês", { exact: true }).count(), 0);
    await page.getByRole("searchbox").fill("Mercado");
    assert.equal(await page.locator(".movement").count(), 1);
    await page.getByRole("searchbox").fill("");
    await button("Filtros").click();
    await fit(`${width}px Filters`);
    await capture(`${width}-movements`);
    await nav("Novo").click();
    await fit(`${width}px Action sheet`);
    await capture(`${width}-new`);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Pagamento", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Pagar Meu cartão/ })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Valor (R$)", { exact: true })
      .waitFor();
    await fit(`${width}px Card payment`);
    await button("Fechar").click();
    await nav("Início").click();
    await button("Metas").click();
    await button("+ Criar").click();
    await fit(`${width}px Goal modal`);
    await button("Fechar").click();
  }
  await nav("Início").click();
  await button("Ocultar valores").click();
  for (const name of ["Início", "Movimentos", "Relatórios", "Ajustes"]) {
    await nav(name).click();
    assert.ok(!(await page.locator("main").innerText()).includes("R$"));
    assert.equal(await page.locator(".chart-fill,progress").count(), 0);
    await fit(`Hidden ${name}`);
  }
  await nav("Planejar").click();
  for (const title of [
    "Cartões",
    "Dívidas e parcelas",
    "Reserva e investimentos",
    "Metas",
  ]) {
    await page.getByRole("tab", { name: title, exact: true }).click();
    assert.ok(!(await page.locator("main").innerText()).includes("R$"));
    assert.equal(await page.locator("progress").count(), 0);
  }
  await nav("Relatórios").click();
  await capture("430-hidden-reports");
  await button("Exibir valores").click();
  assert.ok((await page.locator("main").innerText()).includes("R$"));
  checks.push(
    "privacy across all reports/goals/reserve; reduced motion; search/filters; shared projection",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  await writeFile(
    "test-results/experience/report.json",
    JSON.stringify(
      { passed: checks.length, checks, errors, outbound },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        passed: checks.length,
        errors,
        outbound,
        screenshots: "test-results/experience",
      },
      null,
      2,
    ),
  );
} catch (e) {
  await capture("failure");
  console.error((await page.locator("body").innerText()).slice(-5000));
  throw e;
} finally {
  await browser.close();
  await server.close();
}
