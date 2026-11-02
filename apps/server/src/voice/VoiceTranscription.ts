// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or require.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { VOICE_TRANSCRIPTION_SAMPLE_RATE, type VoiceModelStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import * as ServerConfig from "../config.ts";

export interface SpeechModelFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SpeechModelRelease {
  readonly id: string;
  readonly baseUrl: string;
  readonly files: ReadonlyArray<SpeechModelFile>;
}

// Parakeet TDT 0.6B v3 (25 European languages, punctuated output), int8 export for sherpa-onnx.
// Pinned to a Hugging Face commit; sizes and hashes come from its LFS metadata.
const PARAKEET_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
const PARAKEET_RELEASE: SpeechModelRelease = {
  id: "parakeet-tdt-0.6b-v3-int8",
  baseUrl: `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/${PARAKEET_REVISION}`,
  files: [
    {
      name: "encoder.int8.onnx",
      bytes: 652_184_281,
      sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
    },
    {
      name: "decoder.int8.onnx",
      bytes: 11_845_275,
      sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
    },
    {
      name: "joiner.int8.onnx",
      bytes: 6_355_277,
      sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
    },
    {
      name: "tokens.txt",
      bytes: 93_939,
      sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    },
  ],
};

// sherpa-onnx-node publishes native builds for these targets only.
const SUPPORTED_TARGETS = new Set([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]);

/** A loaded model. `transcribe` takes 16 kHz mono samples in [-1, 1]. */
export interface SpeechEngine {
  readonly transcribe: (samples: Float32Array) => Promise<string>;
}

export type SpeechEngineLoader = (modelDir: string) => Promise<SpeechEngine>;

interface SherpaOnnx {
  readonly OfflineRecognizer: {
    createAsync(config: unknown): Promise<{
      createStream(): {
        acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
      };
      decodeAsync(stream: unknown): Promise<{ readonly text: string }>;
    }>;
  };
}

// The addon stays external; single executables need require to resolve it from disk.
const requireForSherpa = NodeModule.createRequire(import.meta.url);

const loadSherpaEngine: SpeechEngineLoader = async (modelDir) => {
  const sherpa = requireForSherpa("sherpa-onnx-node") as SherpaOnnx;
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: VOICE_TRANSCRIPTION_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${modelDir}/encoder.int8.onnx`,
        decoder: `${modelDir}/decoder.int8.onnx`,
        joiner: `${modelDir}/joiner.int8.onnx`,
      },
      tokens: `${modelDir}/tokens.txt`,
      modelType: "nemo_transducer",
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    transcribe: async (samples) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: VOICE_TRANSCRIPTION_SAMPLE_RATE });
      return (await recognizer.decodeAsync(stream)).text;
    },
  };
};

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    reason: Schema.Literals(["model-missing", "unsupported", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    /** The current model status, then every change. */
    readonly status: Stream.Stream<VoiceModelStatus>;
    /** Starts downloading the model in the background; a no-op while installing or installed. */
    readonly install: Effect.Effect<void, VoiceTranscriptionError>;
    /** Stops a download or deletes the installed model. */
    readonly remove: Effect.Effect<void, VoiceTranscriptionError>;
    /** Takes 16-bit little-endian mono PCM at 16 kHz. */
    readonly transcribe: (pcm16: Uint8Array) => Effect.Effect<string, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscription") {}

export interface VoiceTranscriptionOptions {
  readonly baseDir: string;
  readonly release?: SpeechModelRelease;
  readonly loadEngine?: SpeechEngineLoader;
  /** The loaded model holds about 1 GB of memory, so it is dropped when unused. */
  readonly idleUnloadAfter?: Duration.Input;
}

const DOWNLOAD_TIMEOUT = "30 minutes";

export const makeVoiceTranscription = Effect.fn("VoiceTranscription.make")(function* (
  options: VoiceTranscriptionOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const release = options.release ?? PARAKEET_RELEASE;
  const loadEngine = options.loadEngine ?? loadSherpaEngine;
  const idleUnloadAfter = options.idleUnloadAfter ?? "10 minutes";
  const totalBytes = release.files.reduce((sum, file) => sum + file.bytes, 0);
  const modelsRoot = path.join(options.baseDir, "models");
  const modelDir = path.join(modelsRoot, release.id);
  const supported = SUPPORTED_TARGETS.has(`${platform}-${arch}`);

  // Guards the install fiber, the engine and the status they publish.
  const gate = yield* Semaphore.make(1);
  // Serializes decoding; a decode uses several cores and the native recognizer is shared.
  const decodeGate = yield* Semaphore.make(1);
  let installFiber: Fiber.Fiber<void> | null = null;
  let engine: SpeechEngine | null = null;
  let idleFiber: Fiber.Fiber<void> | null = null;

  const isInstalled = Effect.forEach(release.files, (file) =>
    fs.stat(path.join(modelDir, file.name)).pipe(
      Effect.map((info) => info.type === "File" && Number(info.size) === file.bytes),
      Effect.orElseSucceed(() => false),
    ),
  ).pipe(Effect.map((checks) => checks.every(Boolean)));

  const statusRef = yield* SubscriptionRef.make<VoiceModelStatus>(
    !supported
      ? {
          state: "unsupported",
          detail: `Voice transcription is not available on ${platform}-${arch}.`,
        }
      : (yield* isInstalled)
        ? { state: "installed", totalBytes }
        : { state: "not-installed", totalBytes },
  );

  const downloadFile = Effect.fn("VoiceTranscription.downloadFile")(function* (
    file: SpeechModelFile,
    target: string,
    onBytes: (bytes: number) => Effect.Effect<void>,
  ) {
    const response = yield* http
      .execute(HttpClientRequest.get(`${release.baseUrl}/${file.name}`))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.suspend(() => {
          received += chunk.byteLength;
          if (received > file.bytes) {
            return Effect.fail(
              new VoiceTranscriptionError({
                reason: "failed",
                detail: `${file.name} was larger than expected.`,
              }),
            );
          }
          hash.update(chunk);
          return onBytes(chunk.byteLength);
        }),
      ),
      Stream.run(fs.sink(target, { flag: "wx", mode: 0o600 })),
    );
    if (received !== file.bytes || hash.digest("hex") !== file.sha256) {
      return yield* new VoiceTranscriptionError({
        reason: "failed",
        detail: `${file.name} failed its size or SHA-256 check. Nothing was installed.`,
      });
    }
  });

  const download = Effect.gen(function* () {
    yield* fs.makeDirectory(modelsRoot, { recursive: true });
    // A server that died mid-download leaves its staging directory behind.
    for (const entry of yield* fs.readDirectory(modelsRoot)) {
      if (entry.startsWith(".install-")) {
        yield* fs.remove(path.join(modelsRoot, entry), { recursive: true, force: true });
      }
    }
    // Staging shares the models directory's filesystem so publishing is one rename.
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: modelsRoot,
      prefix: ".install-",
    });
    let receivedBytes = 0;
    let publishedPercent = -1;
    // One status update per percent keeps progress cheap to stream to every client.
    const onBytes = (bytes: number) =>
      Effect.suspend(() => {
        receivedBytes += bytes;
        const percent = Math.floor((receivedBytes * 100) / totalBytes);
        if (percent === publishedPercent) return Effect.void;
        publishedPercent = percent;
        return SubscriptionRef.set(statusRef, {
          state: "downloading",
          receivedBytes,
          totalBytes,
        });
      });
    const unpublished = path.join(staging, "model");
    yield* fs.makeDirectory(unpublished);
    for (const file of release.files) {
      yield* downloadFile(file, path.join(unpublished, file.name), onBytes);
    }
    yield* fs.remove(modelDir, { recursive: true, force: true });
    yield* fs.rename(unpublished, modelDir);
  }).pipe(
    Effect.scoped,
    Effect.timeout(DOWNLOAD_TIMEOUT),
    Effect.mapError((cause) =>
      isVoiceTranscriptionError(cause)
        ? cause
        : new VoiceTranscriptionError({
            reason: "failed",
            detail:
              "The speech model download failed. Check this machine's network access and free disk space.",
            cause,
          }),
    ),
    Effect.withSpan("VoiceTranscription.download"),
  );

  const install = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(statusRef);
        if (current.state === "unsupported") {
          return yield* new VoiceTranscriptionError({
            reason: "unsupported",
            detail: current.detail,
          });
        }
        if (current.state === "downloading" || current.state === "installed") return;
        yield* SubscriptionRef.set(statusRef, {
          state: "downloading",
          receivedBytes: 0,
          totalBytes,
        });
        installFiber = yield* download.pipe(
          Effect.matchCauseEffect({
            onSuccess: () => SubscriptionRef.set(statusRef, { state: "installed", totalBytes }),
            // Remove interrupts the download and publishes its own status.
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("Voice model download failed.", { cause }).pipe(
                    Effect.andThen(
                      SubscriptionRef.set(statusRef, {
                        state: "failed",
                        detail: Option.match(Cause.findErrorOption(cause), {
                          onNone: () => "The speech model download stopped unexpectedly.",
                          onSome: (error) => error.detail,
                        }),
                        totalBytes,
                      }),
                    ),
                  ),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              installFiber = null;
            }),
          ),
          Effect.forkIn(serviceScope),
        );
      }),
    )
    .pipe(Effect.withSpan("VoiceTranscription.install"));

  const dropEngine = Effect.gen(function* () {
    engine = null;
    if (idleFiber) yield* Fiber.interrupt(idleFiber);
    idleFiber = null;
  });

  // Lock order is always decodeGate, then gate. Waiting for the decode gate first lets a
  // running transcription finish before its files go.
  const remove = decodeGate
    .withPermit(
      gate.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(statusRef);
          if (current.state === "unsupported") return;
          if (installFiber) yield* Fiber.interrupt(installFiber);
          yield* dropEngine;
          yield* fs.remove(modelDir, { recursive: true, force: true }).pipe(
            Effect.mapError(
              (cause) =>
                new VoiceTranscriptionError({
                  reason: "failed",
                  detail: "Could not delete the speech model.",
                  cause,
                }),
            ),
          );
          yield* SubscriptionRef.set(statusRef, { state: "not-installed", totalBytes });
        }),
      ),
    )
    .pipe(Effect.withSpan("VoiceTranscription.remove"));

  const loadedEngine = gate.withPermit(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(statusRef);
      if (current.state === "unsupported") {
        return yield* new VoiceTranscriptionError({
          reason: "unsupported",
          detail: current.detail,
        });
      }
      if (current.state !== "installed") {
        return yield* new VoiceTranscriptionError({
          reason: "model-missing",
          detail: "Download the speech model in Settings → Voice input first.",
        });
      }
      if (idleFiber) yield* Fiber.interrupt(idleFiber);
      idleFiber = yield* Effect.sleep(idleUnloadAfter).pipe(
        Effect.andThen(
          decodeGate.withPermit(
            Effect.sync(() => {
              engine = null;
            }),
          ),
        ),
        Effect.forkIn(serviceScope),
      );
      if (engine) return engine;
      // An abandoned load would keep running while the next request loads a second copy.
      const loaded = yield* Effect.tryPromise({
        try: () => loadEngine(modelDir),
        catch: (cause) =>
          new VoiceTranscriptionError({
            reason: "failed",
            detail: "Could not load the speech model on this machine.",
            cause,
          }),
      }).pipe(Effect.uninterruptible);
      engine = loaded;
      return loaded;
    }),
  );

  const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (pcm16: Uint8Array) {
    const sampleCount = Math.floor(pcm16.byteLength / 2);
    const view = new DataView(pcm16.buffer, pcm16.byteOffset, sampleCount * 2);
    const samples = new Float32Array(sampleCount);
    for (let index = 0; index < sampleCount; index++) {
      samples[index] = view.getInt16(index * 2, true) / 32_768;
    }
    yield* Effect.annotateCurrentSpan({ "voice.seconds": sampleCount / 16_000 });
    return yield* decodeGate.withPermit(
      Effect.gen(function* () {
        const loaded = yield* loadedEngine;
        // sherpa-onnx cannot cancel a decode, so the permit stays held until it settles,
        // even when the requesting client disconnects.
        const text = yield* Effect.tryPromise({
          try: () => loaded.transcribe(samples),
          catch: (cause) =>
            new VoiceTranscriptionError({
              reason: "failed",
              detail: "Could not transcribe this recording.",
              cause,
            }),
        }).pipe(Effect.uninterruptible);
        return text.trim();
      }),
    );
  });

  return VoiceTranscription.of({
    status: SubscriptionRef.changes(statusRef),
    install,
    remove,
    transcribe,
  });
});

export const layer = Layer.effect(
  VoiceTranscription,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeVoiceTranscription({ baseDir: config.baseDir });
  }),
);
