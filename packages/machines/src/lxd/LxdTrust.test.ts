import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { parseLxdTrustToken } from "./LxdTrust.ts";

const token = (fields: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      client_name: "t3",
      fingerprint: "a".repeat(64),
      addresses: ["10.0.0.70:8443", "[fd42::1]:8443"],
      secret: "s3cret",
      expires_at: "2030-01-01T00:00:00Z",
      ...fields,
    }),
  ).toString("base64");

describe("parseLxdTrustToken", () => {
  it.effect("reads the server's addresses and certificate fingerprint", () =>
    Effect.gen(function* () {
      const parsed = yield* parseLxdTrustToken(`  ${token({})}\n`);
      assert.strictEqual(parsed.clientName, "t3");
      assert.strictEqual(parsed.fingerprint, "a".repeat(64));
      assert.deepStrictEqual(parsed.addresses, ["10.0.0.70:8443", "[fd42::1]:8443"]);
      // LXD wants the token back exactly as issued.
      assert.strictEqual(parsed.token, token({}));
    }),
  );

  it.effect("refuses text that isn't a token", () =>
    Effect.gen(function* () {
      const error = yield* parseLxdTrustToken("not a token").pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalid");
    }),
  );

  it.effect("refuses an expired token, but not one that never expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2031-01-01T00:00:00Z"));
      const error = yield* parseLxdTrustToken(token({})).pipe(Effect.flip);
      assert.strictEqual(error.reason, "expired");
      const forever = yield* parseLxdTrustToken(token({ expires_at: "0001-01-01T00:00:00Z" }));
      assert.strictEqual(forever.clientName, "t3");
    }),
  );

  it.effect("refuses a token from a server that isn't listening on the network", () =>
    Effect.gen(function* () {
      const error = yield* parseLxdTrustToken(token({ addresses: null })).pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-listening");
    }),
  );
});
