import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as VoiceTranscription from "./VoiceTranscription.ts";

const FILES = { "encoder.onnx": "encoder-bytes", "tokens.txt": "a 0\nb 1\n" };

const makeHarness = Effect.fn("test.makeVoiceTranscription")(function* (
  options: {
    readonly corruptSha?: boolean;
    readonly arch?: NodeJS.Architecture;
    readonly holdFirstDecode?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-test-" });
  const files = yield* Effect.forEach(Object.entries(FILES), ([name, data]) =>
    crypto.digest("SHA-256", new TextEncoder().encode(data)).pipe(
      Effect.orDie,
      Effect.map((digest) => ({
        name,
        bytes: data.length,
        sha256: options.corruptSha ? "0".repeat(64) : Hex.encode(digest),
      })),
    ),
  );
  const decoded: Array<Float32Array> = [];
  const loads: Array<string> = [];
  // The first decode waits for `releaseFirstDecode`, like a native call nothing can cancel.
  let releaseFirstDecode = () => {};
  const firstDecodeHeld = new Promise<void>((resolve) => {
    releaseFirstDecode = resolve;
  });
  let signalFirstDecode = () => {};
  const firstDecodeStarted = new Promise<void>((resolve) => {
    signalFirstDecode = resolve;
  });
  const decodes = { active: 0, maxActive: 0 };
  const voice = yield* VoiceTranscription.makeVoiceTranscription({
    baseDir,
    release: { id: "fixture-model", baseUrl: "https://models.example/fixture", files },
    loadEngine: async (modelDir) => {
      loads.push(modelDir);
      return {
        transcribe: async (samples) => {
          decoded.push(samples);
          decodes.active += 1;
          decodes.maxActive = Math.max(decodes.maxActive, decodes.active);
          try {
            if (options.holdFirstDecode && decoded.length === 1) {
              signalFirstDecode();
              await firstDecodeHeld;
            }
            return "  hello world \n";
          } finally {
            decodes.active -= 1;
          }
        },
      };
    },
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, options.arch ?? "x64"),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const name = request.url.split("/").at(-1) as keyof typeof FILES;
          const response = HttpClientResponse.fromWeb(request, new Response(null));
          return Object.defineProperty(response, "stream", {
            value: Stream.make(new TextEncoder().encode(FILES[name])),
          });
        }),
      ),
    ),
  );
  const settled = voice.status.pipe(
    Stream.filter((status) => status.state === "installed" || status.state === "failed"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  return {
    voice,
    settled,
    decoded,
    loads,
    decodes,
    firstDecodeStarted,
    releaseFirstDecode,
    modelDir: path.join(baseDir, "models", "fixture-model"),
  };
});

it.layer(NodeServices.layer)("VoiceTranscription", (it) => {
  it.effect("installs a verified model, transcribes with it, and removes it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness();
      const missing = yield* harness.voice.transcribe(new Uint8Array(4)).pipe(Effect.flip);
      expect(missing.reason).toBe("model-missing");

      yield* harness.voice.install;
      expect(yield* harness.settled).toEqual({ state: "installed", totalBytes: 21 });
      expect(yield* fs.readFileString(`${harness.modelDir}/tokens.txt`)).toBe(FILES["tokens.txt"]);

      // Little-endian int16: 0x4000 is half scale, 0x8000 is full negative scale.
      const text = yield* harness.voice.transcribe(new Uint8Array([0x00, 0x40, 0x00, 0x80]));
      expect(text).toBe("hello world");
      expect([...harness.decoded[0]!]).toEqual([0.5, -1]);
      yield* harness.voice.transcribe(new Uint8Array(2));
      expect(harness.loads).toEqual([harness.modelDir]);

      yield* harness.voice.remove;
      expect(yield* fs.exists(harness.modelDir)).toBe(false);
      const removed = yield* harness.voice.transcribe(new Uint8Array(2)).pipe(Effect.flip);
      expect(removed.reason).toBe("model-missing");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a decode serialized after its caller goes away", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ holdFirstDecode: true });
      yield* harness.voice.install;
      yield* harness.settled;
      const first = yield* harness.voice
        .transcribe(new Uint8Array(2))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => harness.firstDecodeStarted);

      // A disconnected client interrupts its request while the native decode keeps running.
      const interrupted = yield* Fiber.interrupt(first).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const second = yield* harness.voice
        .transcribe(new Uint8Array(2))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(interrupted.pollUnsafe()).toBeUndefined();
      expect(harness.decoded).toHaveLength(1);

      harness.releaseFirstDecode();
      yield* Fiber.join(interrupted);
      expect(yield* Fiber.join(second)).toBe("hello world");
      expect(harness.decodes.maxActive).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("installs nothing when a file fails its hash check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness({ corruptSha: true });
      yield* harness.voice.install;
      expect(yield* harness.settled).toMatchObject({ state: "failed" });
      expect(yield* fs.exists(harness.modelDir)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("reports platforms without a native build as unsupported", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ arch: "ppc64" });
      const error = yield* harness.voice.install.pipe(Effect.flip);
      expect(error.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );
});
