import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** Environment-backed transcription takes 16 kHz mono audio, which is what Parakeet expects. */
export const VOICE_TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const VOICE_TRANSCRIPTION_MAX_SECONDS = 5 * 60;
const MAX_PCM_BASE64_CHARS = Math.ceil((VOICE_TRANSCRIPTION_MAX_SECONDS * 16_000 * 2) / 3) * 4;

export const VoiceModelStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unsupported"), detail: Schema.String }),
  Schema.Struct({ state: Schema.Literal("not-installed"), totalBytes: NonNegativeInt }),
  Schema.Struct({
    state: Schema.Literal("downloading"),
    receivedBytes: NonNegativeInt,
    totalBytes: NonNegativeInt,
  }),
  Schema.Struct({ state: Schema.Literal("installed"), totalBytes: NonNegativeInt }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    detail: Schema.String,
    totalBytes: NonNegativeInt,
  }),
]);
export type VoiceModelStatus = typeof VoiceModelStatus.Type;

export const VoiceTranscribeInput = Schema.Struct({
  /** Base64 of 16-bit little-endian mono PCM at `VOICE_TRANSCRIPTION_SAMPLE_RATE`. */
  pcm16: Schema.String.check(Schema.isMaxLength(MAX_PCM_BASE64_CHARS)),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({ text: Schema.String });
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export class VoiceRpcError extends Schema.TaggedError<VoiceRpcError>()("VoiceRpcError", {
  /** `model-missing` lets clients send the user to settings instead of offering a retry. */
  reason: Schema.Literals(["model-missing", "unsupported", "failed"]),
  message: Schema.String,
}) {}
