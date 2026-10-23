// Exercise every UI regression with the API surface available in HTTP previews.
Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  value: undefined,
});
