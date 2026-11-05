import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type MachineHostConfig,
  type MachineHostInspection,
  type MachineProfile,
  type UntrackedMachine,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CopyIcon, MoreVertical, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type ChangeEvent, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { machineEnvironment } from "~/state/machines";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

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
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  machineHostNeedsAttention,
  machineHostsAttention,
  machineHostSummary,
  machineProfileDraft,
  type MachineProfileDraft,
  machineProfileSummary,
  machineProjectFixCommands,
  MACHINE_HOST_EXISTING_LXD_COMMANDS,
  MACHINE_HOST_SETUP_COMMAND,
  NEW_MACHINE_PROFILE_DRAFT,
  parseMachineProfileDraft,
} from "./machineSettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";

export function MachinesSettings() {
  return (
    <SettingsSection id="machines" title="Machines">
      <AgentMachineAccessSetting />
      <MachineProfilesSetting />
      <MachineHostsSetting />
    </SettingsSection>
  );
}

function AgentMachineAccessSetting() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      {...searchableSetting("agent-machine-access")}
      serverScoped
      settingKeys={["enableAgentMachineAccess"]}
      description={
        projectScope
          ? "Let agents in this project create test machines from its machine profiles. Applies when the agent session next starts."
          : "Let agents create test machines from the machine profiles below. Off unless a project turns it on."
      }
      resetAction={
        settings.enableAgentMachineAccess !== DEFAULT_SERVER_SETTINGS.enableAgentMachineAccess ? (
          <SettingResetButton
            label="default machine access"
            onClick={() =>
              updateSettings({
                enableAgentMachineAccess: DEFAULT_SERVER_SETTINGS.enableAgentMachineAccess,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentMachineAccess"]}
          aria-label="Agent machine access"
          checked={settings.enableAgentMachineAccess}
          onCheckedChange={(enabled) => updateSettings({ enableAgentMachineAccess: enabled })}
        />
      }
    />
  );
}

function MachineProfilesSetting() {
  const profiles = useScopedSettings((settings) => settings.machineProfiles);
  const updateSettings = useUpdateScopedSettings();
  const [editing, setEditing] = useState<{ readonly original: MachineProfile | null } | null>(null);
  const save = (next: ReadonlyArray<MachineProfile>) => updateSettings({ machineProfiles: next });
  return (
    <SettingsRow
      {...searchableSetting("machine-profiles")}
      serverScoped
      settingKeys={["machineProfiles"]}
      description="The kinds of machines agents may create. Machines keep what they were created with."
      control={
        <Button size="sm" variant="outline" onClick={() => setEditing({ original: null })}>
          <PlusIcon className="size-3.5" /> Add profile
        </Button>
      }
    >
      <div className="pt-1 pb-2">
        {profiles.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No machine profiles.</p>
        ) : null}
        {profiles.map((profile) => (
          <div
            key={profile.name}
            className="flex items-center gap-2 border-t border-border/50 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {machineProfileSummary(profile)}
              </p>
            </div>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`${profile.name} options`}
                  />
                }
              >
                <MoreVertical />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setEditing({ original: profile })}>Edit</MenuItem>
                <MenuItem
                  variant="destructive"
                  onClick={() => save(profiles.filter((entry) => entry.name !== profile.name))}
                >
                  Remove
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ))}
        {editing ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
          >
            {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
            <DialogPopup>
              <MachineProfileForm
                original={editing.original}
                otherNames={profiles
                  .map((profile) => profile.name)
                  .filter((name) => name !== editing.original?.name)}
                onSave={(profile) => {
                  save(
                    editing.original === null
                      ? [...profiles, profile]
                      : profiles.map((entry) =>
                          entry.name === editing.original?.name ? profile : entry,
                        ),
                  );
                  setEditing(null);
                }}
              />
            </DialogPopup>
          </Dialog>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function MachineProfileForm({
  original,
  otherNames,
  onSave,
}: {
  original: MachineProfile | null;
  otherNames: ReadonlyArray<string>;
  onSave: (profile: MachineProfile) => void;
}) {
  const [draft, setDraft] = useState(
    original === null ? NEW_MACHINE_PROFILE_DRAFT : machineProfileDraft(original),
  );
  const [submitted, setSubmitted] = useState(false);
  const parsed = parseMachineProfileDraft(draft, otherNames);
  const field = (key: keyof MachineProfileDraft) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setDraft((current) => ({ ...current, [key]: value }));
  };
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if ("profile" in parsed) onSave(parsed.profile);
        else setSubmitted(true);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {original === null ? "Add machine profile" : `Edit ${original.name}`}
        </DialogTitle>
        <DialogDescription>
          Agents ask for a profile by name, and machines are named after it: node-1, node-2.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="block space-y-1.5">
            <span>Name</span>
            <Input autoFocus value={draft.name} onChange={field("name")} placeholder="node" />
          </label>
          <label className="block space-y-1.5">
            <span>Type</span>
            <Select
              value={draft.type}
              onValueChange={(type) => {
                if (type !== "virtual-machine" && type !== "container") return;
                // Containers can't have extra disks.
                setDraft((current) => ({
                  ...current,
                  type,
                  ...(type === "container" ? { disks: "" } : {}),
                }));
              }}
            >
              <SelectTrigger aria-label="Type">
                <SelectValue>
                  {draft.type === "virtual-machine" ? "Virtual machine" : "Container"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="virtual-machine">Virtual machine</SelectItem>
                <SelectItem value="container">Container</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="col-span-2 block space-y-1.5">
            <span>Image</span>
            <Input value={draft.image} onChange={field("image")} placeholder="ubuntu:24.04" />
          </label>
          <label className="block space-y-1.5">
            <span>CPUs</span>
            <Input type="number" min={1} max={128} value={draft.cpus} onChange={field("cpus")} />
          </label>
          <label className="block space-y-1.5">
            <span>Memory (GiB)</span>
            <Input
              type="number"
              min={1}
              max={1024}
              value={draft.memoryGiB}
              onChange={field("memoryGiB")}
            />
          </label>
          {draft.type === "virtual-machine" ? (
            <label className="col-span-2 block space-y-1.5">
              <span>Extra disks (GiB)</span>
              <Input value={draft.disks} onChange={field("disks")} placeholder="None, or 20, 20" />
            </label>
          ) : null}
          <label className="block space-y-1.5">
            <span>Delete after (hours)</span>
            <Input
              type="number"
              min={1}
              max={720}
              value={draft.lifetimeHours}
              onChange={field("lifetimeHours")}
            />
          </label>
          <label className="block space-y-1.5">
            <span>LXD profiles</span>
            <Input
              value={draft.lxdProfiles}
              onChange={field("lxdProfiles")}
              placeholder="default"
            />
          </label>
        </div>
        {submitted && "error" in parsed ? (
          <p role="alert" className="text-sm text-destructive">
            {parsed.error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
}

const MACHINE_HOSTS_DESCRIPTION =
  "Machines run on LXD servers of yours, in a project T3 Code can't leave.";

function MachineHostsSetting() {
  const { environments } = useSettingsScope();
  return environments.length > 1 ? <MachineHostsSummary /> : <EnvironmentMachineHosts />;
}

/** One line per environment: each connects its own servers, so none is picked for you. */
function MachineHostsSummary() {
  const { scope, environments } = useSettingsScope();
  const [connecting, setConnecting] = useState<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  } | null>(null);
  return (
    <SettingsRow
      {...searchableSetting("machine-hosts")}
      serverScoped
      settingKeys={["machineHosts"]}
      description={`${MACHINE_HOSTS_DESCRIPTION} Each environment connects its own.`}
    >
      <div className="pt-1 pb-2">
        {environments.map((environment) => (
          <MachineHostsSummaryLine
            key={environment.environmentId}
            environment={environment}
            label={settingsScopeEnvironmentLabel(environment, environments)}
            projectScope={scope.kind === "project" || scope.kind === "checkout"}
            onConnect={setConnecting}
          />
        ))}
        {connecting ? (
          <ConnectMachineHostDialog
            environmentId={connecting.environmentId}
            environmentLabel={connecting.label}
            onClose={() => setConnecting(null)}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

function MachineHostsSummaryLine({
  environment,
  label,
  projectScope,
  onConnect,
}: {
  environment: ReturnType<typeof useSettingsScope>["environments"][number];
  label: string;
  projectScope: boolean;
  onConnect: (target: { readonly environmentId: EnvironmentId; readonly label: string }) => void;
}) {
  const { selectScope } = useSettingsScope();
  const environmentId =
    environment.connection.phase === "connected" && environment.serverConfig
      ? environment.environmentId
      : null;
  const hosts = environment.serverConfig?.settings.machineHosts ?? [];
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope) && !projectScope;
  const inspection = useEnvironmentQuery(
    environmentId !== null && hosts.length > 0
      ? machineEnvironment.hosts({ environmentId, input: {} })
      : null,
  );
  const attention =
    inspection.error ?? (inspection.data ? machineHostsAttention(inspection.data) : null);
  return (
    <div className="flex items-center gap-3 border-t border-border/50 py-2">
      <p className="w-52 shrink-0 truncate text-sm font-medium">{label}</p>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
        <p className="truncate text-muted-foreground">
          {environmentId === null
            ? "Not connected"
            : hosts.length === 0
              ? "No LXD server"
              : hosts.map((host) => `${host.label} · ${host.project}`).join(", ")}
        </p>
        {attention !== null ? (
          <p className="flex min-w-0 items-center gap-1 text-warning">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{attention}</span>
          </p>
        ) : null}
      </div>
      {environmentId === null ? null : hosts.length === 0 ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canConfigure}
          onClick={() => onConnect({ environmentId, label })}
        >
          <PlusIcon className="size-3.5" /> Connect server
        </Button>
      ) : (
        // Servers belong to the environment, so managing them leaves any selected project.
        <Button size="sm" variant="ghost" onClick={() => selectScope({ machine: environmentId })}>
          Manage
        </Button>
      )}
    </div>
  );
}

function EnvironmentMachineHosts() {
  const { scope, environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig
      ? environment.environmentId
      : null;
  const hosts = environment?.serverConfig?.settings.machineHosts ?? [];
  // Servers belong to the environment, so a selected project can't change them.
  const canConfigure =
    useEnvironmentScope(environmentId, AuthSettingsWriteScope) &&
    scope.kind !== "project" &&
    scope.kind !== "checkout";
  const inspection = useEnvironmentQuery(
    environmentId !== null && hosts.length > 0
      ? machineEnvironment.hosts({ environmentId, input: {} })
      : null,
  );
  const [connecting, setConnecting] = useState(false);
  const untracked = inspection.data?.untracked ?? [];
  return (
    <SettingsRow
      {...searchableSetting("machine-hosts")}
      serverScoped
      settingKeys={["machineHosts"]}
      description={MACHINE_HOSTS_DESCRIPTION}
      control={
        <>
          {hosts.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={inspection.isPending}
              onClick={inspection.refresh}
            >
              {inspection.isPending ? "Checking…" : "Check"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={environmentId === null || !canConfigure}
            onClick={() => setConnecting(true)}
          >
            <PlusIcon className="size-3.5" /> Connect server
          </Button>
        </>
      }
    >
      <div className="pt-1 pb-2">
        {environmentId === null ? (
          <p className="py-2 text-sm text-muted-foreground">
            Connect the selected environment to manage its LXD servers.
          </p>
        ) : (
          <>
            {hosts.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No LXD servers.</p>
            ) : null}
            {hosts.map((host) => (
              <MachineHostRow
                key={host.id}
                environmentId={environmentId}
                host={host}
                inspection={inspection.data?.hosts.find((entry) => entry.hostId === host.id)}
                canConfigure={canConfigure}
              />
            ))}
            {inspection.error ? (
              <p role="alert" className="py-2 text-xs text-destructive">
                {inspection.error}
              </p>
            ) : null}
            {untracked.length > 0 ? (
              <UntrackedMachines
                environmentId={environmentId}
                hosts={hosts}
                machines={untracked}
                canConfigure={canConfigure}
              />
            ) : null}
            {connecting ? (
              <ConnectMachineHostDialog
                environmentId={environmentId}
                environmentLabel={environment?.label}
                onClose={() => setConnecting(false)}
              />
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

function MachineHostRow({
  environmentId,
  host,
  inspection,
  canConfigure,
}: {
  environmentId: EnvironmentId;
  host: MachineHostConfig;
  inspection: MachineHostInspection | undefined;
  canConfigure: boolean;
}) {
  const disconnect = useAtomCommand(machineEnvironment.disconnectHost, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = inspection?.status;
  const fixes = status ? machineProjectFixCommands(host.project, status) : [];
  const problem = machineHostNeedsAttention(inspection);
  const run = async () => {
    setBusy(true);
    const result = await disconnect({ environmentId, input: { hostId: host.id } });
    setBusy(false);
    setConfirming(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not disconnect ${host.label}`,
        description: errorMessage(squashAtomCommandFailure(result)),
      });
    } else if (result.value.manualCommand !== undefined) {
      toastManager.add({
        type: "warning",
        title: `Remove T3 Code's certificate on ${host.label}`,
        description: `The server didn't answer. Run this there: ${result.value.manualCommand}`,
      });
    }
  };
  return (
    <div className="flex items-start gap-2 border-t border-border/50 py-2.5">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{host.label}</p>
          {problem ? (
            <TriangleAlertIcon aria-label="Needs attention" className="size-3.5 text-warning" />
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {host.address} · project {host.project}
          {status ? ` · ${machineHostSummary(status)}` : null}
        </p>
        {inspection?.error !== undefined ? (
          <p role="status" className="text-xs text-destructive">
            {inspection.error}
          </p>
        ) : null}
        {status !== undefined && !status.versionSupported ? (
          <p role="status" className="text-xs text-warning">
            No new machines until the server runs LXD 6.9 or later. On a snap install, run snap
            refresh lxd --channel=6/stable there.
          </p>
        ) : null}
        {fixes.length > 0 ? (
          <div role="status" className="space-y-1.5 text-xs text-warning">
            <p>
              No new machines until this project keeps them apart from the rest of the network. Run
              this on the server
              {fixes.some((command) => command.includes("=UPLINK"))
                ? ", with your OVN uplink network in place of UPLINK"
                : ""}
              :
            </p>
            <CommandBlock command={fixes.join("\n")} />
          </div>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost-muted"
              disabled={!canConfigure || busy}
              aria-label={`${host.label} options`}
            />
          }
        >
          <MoreVertical />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Disconnect
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {host.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              T3 Code forgets this server and removes its certificate there. Machines on it stay,
              and can be used or released again once you connect the same server and project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void run()}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function UntrackedMachines({
  environmentId,
  hosts,
  machines,
  canConfigure,
}: {
  environmentId: EnvironmentId;
  hosts: ReadonlyArray<MachineHostConfig>;
  machines: ReadonlyArray<UntrackedMachine>;
  canConfigure: boolean;
}) {
  const remove = useAtomCommand(machineEnvironment.deleteUntracked, { reportFailure: false });
  const [pending, setPending] = useState<UntrackedMachine | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (machine: UntrackedMachine) => {
    setBusy(true);
    const result = await remove({
      environmentId,
      input: { hostId: machine.hostId, instance: machine.instance },
    });
    setBusy(false);
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not delete ${machine.instance}`,
        description: errorMessage(squashAtomCommandFailure(result)),
      });
    }
  };
  return (
    <div className="space-y-1 border-t border-border/50 pt-2.5">
      <p className="text-sm font-medium">Machines without a project</p>
      <p className="text-xs text-muted-foreground">
        This environment created them but has lost track of their projects, for example after its
        data was reset. They're never deleted automatically.
      </p>
      {machines.map((machine) => (
        <div
          key={`${machine.hostId}:${machine.instance}`}
          className="flex items-center gap-2 py-1.5"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{machine.instance}</p>
            <p className="truncate text-xs text-muted-foreground">
              {hosts.find((host) => host.id === machine.hostId)?.label ?? machine.hostId} ·{" "}
              {machine.type === "virtual-machine" ? "VM" : "Container"} · {machine.status}
            </p>
          </div>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canConfigure || busy}
            onClick={() => setPending(machine)}
          >
            Delete
          </Button>
        </div>
      ))}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pending?.instance}?</AlertDialogTitle>
            <AlertDialogDescription>
              The machine is deleted from its LXD server with its disks. Anything on it is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (pending) void run(pending);
              }}
            >
              {busy ? "Deleting…" : "Delete machine"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ConnectMachineHostDialog({
  environmentId,
  environmentLabel,
  onClose,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string | undefined;
  onClose: () => void;
}) {
  const connect = useAtomCommand(machineEnvironment.connectHost, { reportFailure: false });
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await connect({
      environmentId,
      input: { trustToken: token.trim(), ...(label.trim() ? { label: label.trim() } : {}) },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    toastManager.add({ type: "success", title: `Connected ${result.value.label}` });
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim() && !busy) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {environmentLabel
                ? `Connect an LXD server to ${environmentLabel}`
                : "Connect an LXD server"}
            </DialogTitle>
            <DialogDescription>
              Paste a trust token for a project on the server. T3 Code's certificate there only
              reaches that project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                How do I get a trust token?
              </summary>
              <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                <p>
                  On a fresh Ubuntu server, this installs LXD and OVN, makes the project, and prints
                  a token:
                </p>
                <CommandBlock command={MACHINE_HOST_SETUP_COMMAND} />
                <p>
                  On a server with LXD 6.9 or later and OVN, run these, with your OVN uplink network
                  in place of UPLINK and your storage pool in place of local:
                </p>
                <CommandBlock command={MACHINE_HOST_EXISTING_LXD_COMMANDS} />
              </div>
            </details>
            <label className="block space-y-1.5 text-sm">
              <span>Trust token</span>
              <Textarea
                autoFocus
                required
                rows={3}
                value={token}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <Input
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="The server's own name"
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={busy || !token.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function CommandBlock({ command }: { command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/50 py-1.5 pr-1.5 pl-2.5">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all py-0.5 font-mono text-xs text-foreground">
        {command}
      </code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
