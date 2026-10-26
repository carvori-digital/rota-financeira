import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { createUuid } from "../src/lib/uuid.ts";

const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uses the native UUID method with its Crypto receiver", (t) => {
  const source = {
    randomUUID() {
      assert.equal(this, source);
      return "00000000-0000-4000-8000-000000000000";
    },
    getRandomValues() {
      assert.fail("native UUID should not need the fallback");
    },
  };
  t.mock.getter(globalThis, "crypto", () => source as unknown as Crypto);
  assert.equal(createUuid(), "00000000-0000-4000-8000-000000000000");
});

test("HTTP fallback uses 16 cryptographic bytes and sets UUID v4 version/variant", (t) => {
  let calls = 0;
  const source = {
    getRandomValues(bytes: Uint8Array) {
      assert.equal(this, source);
      assert.equal(bytes.length, 16);
      calls++;
      bytes.forEach((_, i) => (bytes[i] = i));
      bytes[6] = 0xf6;
      bytes[8] = 0xc8;
      return bytes;
    },
  };
  t.mock.getter(globalThis, "crypto", () => source as unknown as Crypto);
  t.mock.method(Math, "random", () => assert.fail("no insecure randomness"));
  assert.equal(createUuid(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.equal(calls, 1);
});

test("fallback UUIDs from the real cryptographic source are valid and distinct", (t) => {
  t.mock.getter(
    globalThis,
    "crypto",
    () =>
      ({
        getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      }) as Crypto,
  );
  const ids = Array.from({ length: 1000 }, createUuid);
  ids.forEach((id) => assert.match(id, uuidV4));
  assert.equal(new Set(ids).size, ids.length);
});

test("absence of secure entropy fails explicitly without using Math.random", (t) => {
  t.mock.method(Math, "random", () => assert.fail("no insecure randomness"));
  for (const source of [undefined, {}]) {
    t.mock.getter(globalThis, "crypto", () => source as Crypto);
    assert.throws(createUuid, /geração segura de identificadores/);
  }
});
