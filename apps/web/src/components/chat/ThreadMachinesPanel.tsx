import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MachineState, MachineView, ThreadId } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  machineDeletionLabel,
  machineSpecLabel,
  machineStateLabel,
} from "@t3tools/client-runtime/state/machines";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, ServerIcon, Settings2Icon, SquareTerminalIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { machineEnvironment } from "~/state/machines";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { useNowMinute } from "../../hooks/useNowMinute";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const STATE_DOT_CLASS = {
  creating: "bg-sky-500",
  starting: "bg-sky-500",
  ready: "bg-emerald-500",
  stopped: "bg-muted-foreground/40",
  releasing: "bg-muted-foreground/40",
  failed: "bg-destructive",
  missing: "bg-destructive",
  disconnected: "bg-warning",
} satisfies Record<MachineState, string>;

// Settings change rarely, so subscribing only where an LXD server is connected costs nothing elsewhere.
const selectHasMachineHosts = (settings: UnifiedSettings) => settings.machineHosts.length > 0;

export function ThreadMachinesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onRunShellCommand?: ((command: string) => void) | undefined;
}) {
  const hasHosts = useEnvironmentSettings(props.environmentId, selectHasMachineHosts);
  const machinesQuery = useEnvironmentQuery(
    hasHosts
      ? machineEnvironment.thread({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const canRelease = useAtomValue(machineEnvironment.release.permissionAtom(props.environmentId));
  const release = useAtomCommand(machineEnvironment.release, { reportFailure: false });
  const navigate = useNavigate();
  const now = Date.parse(`${useNowMinute()}Z`);
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (name) =>
      toastManager.add({ type: "success", title: `Copied the ssh command for ${name}` }),
  });
  const [pendingRelease, setPendingRelease] = useState<MachineView | null>(null);
  const [releasing, setReleasing] = useState(false);

  const machines = machinesQuery.data?.machines ?? [];
  if (machines.length === 0) return null;

  const runRelease = async (machine: MachineView) => {
    setReleasing(true);
    const result = await release({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, name: machine.name },
    });
    setReleasing(false);
    setPendingRelease(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not release ${machine.name}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-machines-heading"
      title="Machines"
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Machine settings"
                onClick={() =>
                  void navigate({
                    to: "/settings/integrations",
                    search: { machine: props.environmentId },
                    hash: "machines",
                    hashScrollIntoView: false,
                    state: { settingsTargetHighlight: true },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Machine settings</TooltipPopup>
        </Tooltip>
      }
    >
      <ul className="m-0 list-none p-0">
        {machines.map((machine) => {
          // ssh starts a stopped machine, so it's as reachable as a running one.
          const reachable = machine.state === "ready" || machine.state === "stopped";
          const status = [
            machineStateLabel(machine.state),
            machineSpecLabel(machine),
            machineDeletionLabel(machine.expiresAt, now),
          ].join(" · ");
          return (
            <li
              key={machine.name}
              className={cn(
                "group flex items-center rounded-lg py-1.5",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                <ServerIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span
                  className={cn(
                    "absolute -right-1 -top-1 size-1.5 rounded-full",
                    STATE_DOT_CLASS[machine.state],
                  )}
                  aria-hidden
                />
              </span>
              <Tooltip>
                <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                  <span className="block truncate text-sm font-medium text-foreground/80">
                    {machine.name}
                  </span>
                  <p className="truncate text-2xs text-muted-foreground">{status}</p>
                </TooltipTrigger>
                <TooltipPopup side="left">
                  <p className="font-medium">
                    {machine.name} · {machine.profile}
                  </p>
                  <p className="text-muted-foreground">{status}</p>
                  <p className="text-muted-foreground">
                    {machine.image} on {machine.hostLabel}
                  </p>
                  <p className="text-muted-foreground">
                    {[machine.dnsName, ...machine.addresses].join(" · ")}
                  </p>
                  {machine.error ? <p className="text-destructive">{machine.error}</p> : null}
                </TooltipPopup>
              </Tooltip>
              {props.onRunShellCommand && reachable ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        aria-label={`Open a terminal on ${machine.name}`}
                        onClick={() => props.onRunShellCommand?.(machine.sshCommand)}
                      >
                        <SquareTerminalIcon className="size-3.5" />
                      </ThreadDetailsControl>
                    }
                  />
                  <TooltipPopup>Open terminal</TooltipPopup>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`Copy the ssh command for ${machine.name}`}
                      onClick={() => copyToClipboard(machine.sshCommand, machine.name)}
                    >
                      <CopyIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Copy ssh command</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`Release ${machine.name}`}
                      disabled={!canRelease || releasing || machine.state === "releasing"}
                      onClick={() => setPendingRelease(machine)}
                    >
                      <TrashIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Release</TooltipPopup>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <AlertDialog
        open={pendingRelease !== null}
        onOpenChange={(open) => {
          if (!open && !releasing) setPendingRelease(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Release {pendingRelease?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The machine is deleted with its disks, and anything on it is lost. If the agent is
              still using it, its commands there fail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={releasing}
              render={<Button variant="outline" disabled={releasing} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={releasing}
              onClick={() => {
                if (pendingRelease) void runRelease(pendingRelease);
              }}
            >
              {releasing ? "Releasing…" : "Release"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ThreadDetailsSection>
  );
}
