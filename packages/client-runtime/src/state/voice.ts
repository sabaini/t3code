import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    modelStatus: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:voice:model-status",
      tag: WS_METHODS.voiceSubscribeModelStatus,
    }),
    installModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:install-model",
      tag: WS_METHODS.voiceInstallModel,
    }),
    removeModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:remove-model",
      tag: WS_METHODS.voiceRemoveModel,
    }),
    transcribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:transcribe",
      tag: WS_METHODS.voiceTranscribe,
    }),
  };
}
