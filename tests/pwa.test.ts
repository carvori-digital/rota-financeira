import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("PWA tem manifest, ícones PNG válidos e configuração iOS", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "Rota Financeira");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  for (const icon of manifest.icons) {
    const data = await readFile(
      new URL(`../public${icon.src}`, import.meta.url),
    );
    assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(
      `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`,
      icon.sizes,
    );
  }
  const html = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /viewport-fit=cover/);
});
test("service worker não intercepta nem persiste respostas financeiras", async () => {
  const source = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /caches\.|indexedDB|localStorage|respondWith/);
  assert.match(source, /skipWaiting/);
  assert.match(source, /clients.claim/);
});
