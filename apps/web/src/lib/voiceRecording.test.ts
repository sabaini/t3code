import { afterEach, expect, it, vi } from "vite-plus/test";

import { createBrowserVoiceRecording } from "./voiceRecording";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("closes a microphone granted after voice input was cancelled", async () => {
  const stopTrack = vi.fn();
  let grant = (_stream: MediaStream) => {};
  vi.stubGlobal("MediaRecorder", vi.fn());
  vi.stubGlobal("OfflineAudioContext", vi.fn());
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    },
  });
  const recording = createBrowserVoiceRecording(() => {});

  const permission = recording.requestPermission();
  recording.releaseStream();
  grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);

  await expect(permission).resolves.toEqual({ granted: false, canAskAgain: true });
  expect(stopTrack).toHaveBeenCalledOnce();
});
