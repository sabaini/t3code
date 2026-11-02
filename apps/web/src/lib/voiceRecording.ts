import {
  VOICE_TRANSCRIPTION_MAX_SECONDS,
  VOICE_TRANSCRIPTION_SAMPLE_RATE,
} from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceRecorder,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import * as Base64 from "effect/encoding/Base64";

/** Finished recordings by the opaque uri the shared controller passes around. */
const recordings = new Map<string, Blob>();
let nextRecordingId = 0;

export function browserSupportsVoiceRecording(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined" &&
    typeof OfflineAudioContext !== "undefined"
  );
}

/**
 * The microphone is acquired when permission is requested, so the browser prompts on the
 * user's click, and released whenever the controller is not recording.
 */
export function createBrowserVoiceRecording(onStatus: (status: VoiceRecorderStatus) => void) {
  let stream: MediaStream | null = null;
  // Bumped on release, so a prompt answered after the user cancelled closes its stream.
  let streamGeneration = 0;
  let mediaRecorder: MediaRecorder | null = null;
  let stopped: Promise<void> = Promise.resolve();
  let limitTimer: ReturnType<typeof setTimeout> | null = null;

  const stopTracks = (target: MediaStream) => {
    for (const track of target.getTracks()) track.stop();
  };
  const releaseStream = () => {
    streamGeneration += 1;
    if (stream) stopTracks(stream);
    stream = null;
  };

  const stopRecorder = async () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    await stopped;
  };

  const recorder: VoiceRecorder & { uri: string | null } = {
    uri: null,
    prepareToRecordAsync: async () => {
      if (!stream) throw new Error("The microphone is not open.");
      const chunks: Blob[] = [];
      const next = new MediaRecorder(stream);
      recorder.uri = null;
      next.addEventListener("dataavailable", (event) => chunks.push(event.data));
      stopped = new Promise((resolve) => {
        // Also fires when the time limit is reached or the microphone goes away. The
        // controller ignores the status when it asked for the stop itself.
        next.addEventListener("stop", () => {
          if (limitTimer !== null) clearTimeout(limitTimer);
          limitTimer = null;
          const uri = `voice-recording:${++nextRecordingId}`;
          recordings.set(uri, new Blob(chunks, { type: next.mimeType }));
          recorder.uri = uri;
          resolve();
          onStatus({ isFinished: true, hasError: false, error: null, url: uri });
        });
      });
      next.addEventListener("error", () => {
        onStatus({
          isFinished: false,
          hasError: true,
          error: "The microphone stopped recording.",
          url: null,
        });
      });
      mediaRecorder = next;
    },
    record: ({ forDuration }) => {
      mediaRecorder?.start();
      limitTimer = setTimeout(() => void stopRecorder(), forDuration * 1000);
    },
    stop: stopRecorder,
  };

  return {
    recorder,
    requestPermission: async () => {
      if (!browserSupportsVoiceRecording()) return { granted: false, canAskAgain: false };
      if (stream) return { granted: true, canAskAgain: true };
      const generation = streamGeneration;
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        if (generation !== streamGeneration) {
          stopTracks(acquired);
          return { granted: false, canAskAgain: true };
        }
        stream = acquired;
        return { granted: true, canAskAgain: true };
      } catch (error) {
        // A denied prompt stays denied until the user changes the site's permissions.
        const denied = error instanceof DOMException && error.name === "NotAllowedError";
        return { granted: false, canAskAgain: !denied };
      }
    },
    releaseStream,
    deleteRecording: (uri: string) => {
      recordings.delete(uri);
    },
  };
}

/** Mixes down to mono 16-bit little-endian PCM at the rate the environment transcribes. */
async function recordingToPcm16(recording: Blob): Promise<Uint8Array> {
  // Decoding through a 16 kHz context resamples as well.
  const context = new OfflineAudioContext(1, 1, VOICE_TRANSCRIPTION_SAMPLE_RATE);
  const audio = await context.decodeAudioData(await recording.arrayBuffer());
  // The recorder stops on a timer that can fire late; the environment rejects longer audio.
  const length = Math.min(
    audio.length,
    VOICE_TRANSCRIPTION_SAMPLE_RATE * VOICE_TRANSCRIPTION_MAX_SECONDS,
  );
  const pcm = new Uint8Array(length * 2);
  const view = new DataView(pcm.buffer);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  for (let index = 0; index < length; index++) {
    let sample = 0;
    for (const channel of channels) sample += channel[index] ?? 0;
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(index * 2, Math.round(sample * 32_767), true);
  }
  return pcm;
}

export class EnvironmentTranscriptionFailure extends Error {
  readonly needsSetup: boolean;

  constructor(message: string, needsSetup: boolean) {
    super(message);
    this.needsSetup = needsSetup;
  }
}

/** Transcribes on the environment that owns the draft, with the model it downloaded. */
export function createEnvironmentVoiceTranscriber(input: {
  readonly modelInstalled: () => boolean;
  readonly transcribe: (pcm16: string) => Promise<string>;
}): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      if (!input.modelInstalled()) {
        throw new VoiceTranscriptionError(
          "setup-required",
          "Download the speech model in Settings → Chat to use voice input.",
        );
      }
      return {
        locale: navigator.language,
        transcribe: async (uri, options) => {
          const recording = recordings.get(uri);
          if (!recording) {
            throw new VoiceTranscriptionError("transcription-failed", "The recording is gone.");
          }
          const pcm = await recordingToPcm16(recording);
          throwIfVoiceTranscriptionAborted(options.signal);
          try {
            return await input.transcribe(Base64.encode(pcm));
          } catch (error) {
            if (error instanceof EnvironmentTranscriptionFailure && error.needsSetup) {
              throw new VoiceTranscriptionError("setup-required", error.message, { cause: error });
            }
            throw new VoiceTranscriptionError(
              "transcription-failed",
              "Could not transcribe this recording.",
              { cause: error },
            );
          }
        },
      };
    },
  };
}
