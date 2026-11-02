import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type VoiceModelStatus,
  VoiceRpcError,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  browserSupportsVoiceRecording,
  createBrowserVoiceRecording,
  createEnvironmentVoiceTranscriber,
  EnvironmentTranscriptionFailure,
} from "~/lib/voiceRecording";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { voiceEnvironment } from "~/state/voice";

import { toastManager } from "../ui/toast";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const isVoiceRpcError = Schema.is(VoiceRpcError);

type TranscribeInput = {
  readonly environmentId: EnvironmentId;
  readonly input: VoiceTranscribeInput;
};

export interface ComposerVoiceDraft {
  /** Markdown with the selection in expanded coordinates. */
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
}

export function useComposerVoiceInput(input: {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly disabled: boolean;
  readonly readDraft: () => ComposerVoiceDraft;
  readonly commitDraft: (text: string, cursor: number) => void;
}) {
  const status = useEnvironmentQuery(
    voiceEnvironment.modelStatus({ environmentId: input.environmentId, input: {} }),
  ).data;
  const canTranscribe = useAtomValue(
    voiceEnvironment.transcribe.permissionAtom(input.environmentId),
  );
  const transcribe = useAtomCommand(voiceEnvironment.transcribe, { reportFailure: false });
  const navigate = useNavigate();
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);

  const context = useStableCallback(() => ({ input, status, transcribe, navigate }));
  const controllerRef = useRef<VoiceInputController | null>(null);
  const startedOwnerRef = useRef<string | null>(null);
  const controller = useStableCallback(() => {
    if (controllerRef.current === null) {
      controllerRef.current = createComposerVoiceController(context, (next) => {
        setRecordingStartedAt(next.phase === "recording" ? Date.now() : null);
        setState(next);
      });
    }
    return controllerRef.current;
  });

  const ownerKey = input.ownerKey;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a recording belongs to one draft; switching drafts abandons it.
  useEffect(() => {
    if (startedOwnerRef.current !== null && startedOwnerRef.current !== ownerKey) {
      startedOwnerRef.current = null;
      controllerRef.current?.ownerChanged();
    }
  }, [ownerKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone when the composer unmounts.
  useEffect(() => () => controllerRef.current?.dispose(), []);

  const available =
    canTranscribe &&
    status !== null &&
    status.state !== "unsupported" &&
    browserSupportsVoiceRecording();
  const busy = voiceInputBlocksSubmission(state);
  const toggle = useStableCallback(() => {
    const voice = controller();
    if (voice.currentState.phase === "recording") {
      void voice.stop();
      return;
    }
    if (voiceInputBlocksSubmission(voice.currentState) || input.disabled) return;
    startedOwnerRef.current = input.ownerKey;
    void voice.start();
  });
  const stop = useStableCallback(() => void controller().stop());
  const cancel = useStableCallback(() => controller().cancel());
  return { available, state, recordingStartedAt, blocksSubmission: busy, toggle, stop, cancel };
}

type VoiceContext = () => {
  readonly input: Parameters<typeof useComposerVoiceInput>[0];
  readonly status: VoiceModelStatus | null;
  readonly transcribe: (
    value: TranscribeInput,
  ) => Promise<AtomCommandResult<VoiceTranscribeResult, unknown>>;
  readonly navigate: ReturnType<typeof useNavigate>;
};

function createComposerVoiceController(
  context: VoiceContext,
  onState: (state: VoiceInputState) => void,
): VoiceInputController {
  const recording = createBrowserVoiceRecording((recorderStatus) => {
    void controller.handleRecorderStatus(recorderStatus);
  });
  const controller: VoiceInputController = new VoiceInputController({
    recorder: recording.recorder,
    getTranscriber: () =>
      createEnvironmentVoiceTranscriber({
        modelInstalled: () => context().status?.state === "installed",
        transcribe: async (pcm16) => {
          const { input, transcribe } = context();
          const result = await transcribe({ environmentId: input.environmentId, input: { pcm16 } });
          if (result._tag === "Success") return result.value.text;
          const error = squashAtomCommandFailure(result);
          throw isVoiceRpcError(error)
            ? new EnvironmentTranscriptionFailure(error.message, error.reason === "model-missing")
            : error;
        },
      }),
    requestPermission: recording.requestPermission,
    configureRecording: async () => undefined,
    releaseRecording: async () => recording.releaseStream(),
    deleteRecording: recording.deleteRecording,
    readDraft: () => {
      const { input } = context();
      return { ownerKey: input.ownerKey, ...input.readDraft(), revision: 0 };
    },
    commitDraft: (text, selection) => context().input.commitDraft(text, selection.end),
    onStateChange: (next) => {
      // The microphone stays open only while preparing or recording.
      if (next.phase !== "preparing" && next.phase !== "recording") recording.releaseStream();
      onState(next);
      if (next.phase !== "error" || !next.error) return;
      // A missing model is fixed in T3 settings; a blocked microphone in the browser's.
      const { input, status, navigate } = context();
      const opensSettings = next.errorAction === "settings" && status?.state !== "installed";
      const machine = input.environmentId;
      toastManager.add({
        type: "error",
        title: next.error,
        ...(opensSettings
          ? {
              actionProps: {
                children: "Open settings",
                onClick: () => void navigate({ to: "/settings/chat", search: { machine } }),
              },
            }
          : {}),
      });
    },
  });
  return controller;
}
