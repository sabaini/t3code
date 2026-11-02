import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type VoiceModelStatus } from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { voiceEnvironment } from "~/state/voice";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

function statusDescription(status: VoiceModelStatus | null): string {
  const intro =
    "Dictate into the composer on web and desktop. Speech is transcribed on this environment with NVIDIA's Parakeet model, which understands 25 European languages.";
  switch (status?.state) {
    case undefined:
      return intro;
    case "unsupported":
      return status.detail;
    case "not-installed":
      return `${intro} The model is a ${megabytes(status.totalBytes)} download.`;
    case "downloading":
      return `Downloading the speech model: ${megabytes(status.receivedBytes)} of ${megabytes(status.totalBytes)}.`;
    case "installed":
      return `${intro} The model is installed.`;
    case "failed":
      return status.detail;
  }
}

export function VoiceInputSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const status = useEnvironmentQuery(
    environmentId === null ? null : voiceEnvironment.modelStatus({ environmentId, input: {} }),
  ).data;
  const install = useAtomCommand(voiceEnvironment.installModel, { reportFailure: false });
  const remove = useAtomCommand(voiceEnvironment.removeModel, { reportFailure: false });
  // Servers from before voice input never answer; their settings show nothing.
  if (environmentId === null || status === null) return null;
  // Each environment has its own model, so a download needs exactly one destination.
  if (connectedEnvironments.length > 1) {
    return (
      <SettingsSection id="voice-input" title="Voice input">
        <SettingsRow
          {...searchableSetting("voice-input-model")}
          description="Each environment downloads its own speech model. Choose one environment above to manage it."
        />
      </SettingsSection>
    );
  }

  const run = async (command: typeof install, failureTitle: string) => {
    const result = await command({ environmentId, input: {} });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const control =
    status.state === "unsupported" || !canConfigure ? null : status.state === "installed" ? (
      <Button size="sm" variant="outline" onClick={() => void run(remove, "Could not remove")}>
        Remove model
      </Button>
    ) : status.state === "downloading" ? (
      <Button size="sm" variant="outline" onClick={() => void run(remove, "Could not cancel")}>
        Cancel
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={() => void run(install, "Download failed")}>
        {status.state === "failed" ? "Retry download" : "Download model"}
      </Button>
    );

  return (
    <SettingsSection id="voice-input" title="Voice input">
      <SettingsRow
        {...searchableSetting("voice-input-model")}
        description={statusDescription(status)}
        control={control}
      />
    </SettingsSection>
  );
}
