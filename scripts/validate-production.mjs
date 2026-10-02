import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
const url = "https://rota-financeira-delta.vercel.app/";
export async function startProductionBrowser() {
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE
      ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
      : "playwright"
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const context = await browser.newContext({
      viewport: { width: 375, height: 844 },
    }),
    page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const oldWorker = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { active: !!r?.active, script: r?.active?.scriptURL };
  });
  assert.equal(oldWorker.active, true);
  console.log("PWA anterior instalada no navegador de validação.");
  return { browser, context, page, oldWorker };
}
export async function validateProduction(state, actor, signal) {
  assert.equal(signal.url, url);
  assert.match(signal.commit, /^[a-f0-9]{40}$/);
  const release = await fetch(url + "release.json?validate=" + Date.now(), {
    cache: "no-store",
  });
  assert.equal(release.status, 200);
  assert.equal((await release.json()).commit, signal.commit);
  const errors = [];
  const { page } = state;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.reload({ waitUntil: "networkidle", timeout: 60000 });
  await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    await r.update();
    await navigator.serviceWorker.ready;
  });
  await page.getByLabel("E-mail", { exact: true }).fill(actor.email);
  await page.getByLabel("Senha", { exact: true }).fill(actor.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByText("Livre depois dos compromissos · mês atual", { exact: true })
    .waitFor({ timeout: 30000 });
  await mkdir("test-results/production", { recursive: true });
  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const fit = await page.evaluate(() => ({
      w: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(fit.scroll <= fit.w);
    await page.screenshot({
      path: "test-results/production/" + width + "-home.png",
      fullPage: true,
    });
  }
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Planejar", exact: true }).click();
  for (const name of [
    "Visão do mês",
    "Próximos meses",
    "Cartões",
    "Dívidas / Parcelas",
    "Recorrentes",
    "Investimentos/Reserva",
  ])
    await page.getByRole("tab", { name, exact: true }).click();
  await nav.getByRole("button", { name: "Adicionar", exact: true }).click();
  assert.equal(
    await page.getByRole("dialog").locator(".quick-actions button").count(),
    8,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fechar", exact: true })
    .click();
  await nav.getByRole("button", { name: "Início", exact: true }).click();
  await page
    .getByRole("button", { name: "Configuração rápida", exact: true })
    .click();
  for (let i = 0; i < 6; i++)
    await page
      .getByRole("button", { name: "Continuar / pular etapa", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Ver minha Home", exact: true })
    .click();
  await nav.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page
    .getByText("Rota Financeira · v0.2 · " + signal.commit.slice(0, 7), {
      exact: true,
    })
    .waitFor();
  const sw = await fetch(url + "sw.js?validate=" + Date.now(), {
    cache: "no-store",
  });
  assert.ok((await sw.text()).includes(signal.commit));
  const pwa = await page.evaluate(async () => ({
    controller: !!navigator.serviceWorker.controller,
    caches: await caches.keys(),
    manifest: !!document.querySelector('link[rel="manifest"]'),
  }));
  assert.equal(pwa.controller, true);
  assert.deepEqual(pwa.caches, []);
  assert.equal(pwa.manifest, true);
  await page
    .getByRole("button", { name: "Sair da conta", exact: true })
    .click();
  await page.getByText("Bem-vindo de volta", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS PRODUÇÃO: commit exato no domínio, Auth/PostgREST, Home/Planejar/Novo/configuração rápida, mobile 375/390/430, atualização da PWA anterior e zero erros JavaScript.",
  );
}
