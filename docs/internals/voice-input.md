# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. iOS transcribes on the device. Web and desktop send audio to the
environment that owns the draft, which runs Parakeet through sherpa-onnx's native
addon ([VoiceTranscription](../../apps/server/src/voice/VoiceTranscription.ts)).

Transcription belongs to the environment, not the client, so a remote desktop or a browser
on app.t3.codes uses the same model as the desktop, and the model is downloaded
once per environment. It is an explicit download from settings because it is
670 MB. Clients decode and resample to 16 kHz mono PCM before sending: the server
has no audio decoder, and every browser can decode what its own MediaRecorder
writes. Five minutes of that PCM is about 13 MB of base64 in one RPC, in line
with image attachments. The loaded model takes about 1 GB of memory, so the
server drops it after ten idle minutes. Android records AAC, which the server
cannot decode, so it has no voice input yet.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
