import {
  MachineImage,
  MachineProfile,
  MachineProfileName,
  type MachineType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface MachineProfileDraft {
  readonly name: string;
  readonly type: MachineType;
  readonly image: string;
  readonly cpus: string;
  readonly memoryGiB: string;
  /** Sizes in GiB, separated by commas. */
  readonly disks: string;
  readonly lifetimeHours: string;
  /** LXD profile names, separated by commas. */
  readonly lxdProfiles: string;
}

export const NEW_MACHINE_PROFILE_DRAFT: MachineProfileDraft = {
  name: "",
  type: "virtual-machine",
  image: "ubuntu:24.04",
  cpus: "2",
  memoryGiB: "2",
  disks: "",
  lifetimeHours: "24",
  lxdProfiles: "default",
};

export const machineProfileDraft = (profile: MachineProfile): MachineProfileDraft => ({
  name: profile.name,
  type: profile.type,
  image: profile.image,
  cpus: String(profile.cpus),
  memoryGiB: String(profile.memoryGiB),
  disks: profile.diskSizesGiB.join(", "),
  lifetimeHours: String(profile.lifetimeHours),
  lxdProfiles: profile.lxdProfiles.join(", "),
});

const isProfileName = Schema.is(MachineProfileName);
const isImage = Schema.is(MachineImage);
const decodeProfile = Schema.decodeUnknownOption(MachineProfile);
const list = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** The profile a draft describes, or what to fix, in words for the form. */
export function parseMachineProfileDraft(
  draft: MachineProfileDraft,
  otherNames: ReadonlyArray<string>,
): { readonly profile: MachineProfile } | { readonly error: string } {
  const name = draft.name.trim();
  if (!isProfileName(name)) {
    return {
      error: "Name the profile with lowercase letters, digits and hyphens, starting with a letter.",
    };
  }
  if (otherNames.includes(name)) return { error: `There's a profile called ${name} already.` };
  const image = draft.image.trim();
  if (!isImage(image)) {
    return {
      error:
        "Use an image from ubuntu: or ubuntu-daily:, like ubuntu:24.04, or the alias of an image on the LXD server.",
    };
  }
  const disks = list(draft.disks).map(Number);
  if (disks.some((size) => !Number.isInteger(size) || size < 1)) {
    return { error: "List extra disks as sizes in GiB, like 20, 20." };
  }
  if (draft.type === "container" && disks.length > 0) {
    return { error: "Only virtual machines can have extra disks." };
  }
  const lxdProfiles = list(draft.lxdProfiles);
  const decoded = decodeProfile({
    name,
    type: draft.type,
    image,
    cpus: Number(draft.cpus),
    memoryGiB: Number(draft.memoryGiB),
    diskSizesGiB: disks,
    lifetimeHours: Number(draft.lifetimeHours),
    lxdProfiles: lxdProfiles.length > 0 ? lxdProfiles : ["default"],
  });
  return Option.match(decoded, {
    onNone: () => ({
      error:
        "Use 1 to 128 CPUs, 1 to 1024 GiB of memory, at most 16 extra disks, and a lifetime of 1 to 720 hours.",
    }),
    onSome: (profile) => ({ profile }),
  });
}

/** Like "VM · ubuntu:24.04 · 2 CPUs · 4 GiB · 2 disks · 24h". */
export function machineProfileSummary(profile: MachineProfile): string {
  const disks = profile.diskSizesGiB.length;
  return [
    profile.type === "virtual-machine" ? "VM" : "Container",
    profile.image,
    `${profile.cpus} ${profile.cpus === 1 ? "CPU" : "CPUs"}`,
    `${profile.memoryGiB} GiB`,
    ...(disks === 0 ? [] : [`${disks} extra ${disks === 1 ? "disk" : "disks"}`]),
    `deleted after ${profile.lifetimeHours}h`,
  ].join(" · ");
}

/** The commands that fix a project LXD refuses to make machines in. */
export function machineProjectFixCommands(
  project: string,
  status: { readonly missing: ReadonlyArray<string>; readonly unsafe: ReadonlyArray<string> },
): ReadonlyArray<string> {
  return [
    ...(status.missing.length === 0
      ? []
      : [`lxc project set ${project} ${status.missing.join(" ")}`]),
    ...status.unsafe.map((key) => `lxc project unset ${project} ${key}`),
  ];
}

/** Like "LXD 6.10 · VMs and containers". */
export function machineHostSummary(status: {
  readonly version: string;
  readonly instanceTypes: ReadonlyArray<string>;
}): string {
  const vms = status.instanceTypes.includes("virtual-machine");
  const containers = status.instanceTypes.includes("container");
  const kinds =
    vms && containers
      ? "VMs and containers"
      : containers
        ? "containers only, no /dev/kvm"
        : vms
          ? "VMs only"
          : "no instance types";
  return `LXD ${status.version} · ${kinds}`;
}

export const MACHINE_HOST_SETUP_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/sabaini/t3code/main/scripts/machines/setup-lxd-host.sh | sudo bash";

export const MACHINE_HOST_EXISTING_LXD_COMMANDS = [
  "lxc project create t3-machines \\",
  "  -c features.images=true -c features.profiles=true -c features.networks=true \\",
  "  -c restricted=true -c restricted.snapshots=allow \\",
  "  -c restricted.networks.uplinks=UPLINK",
  "lxc profile device add default root disk path=/ pool=local --project t3-machines",
  "lxc config trust add --name t3-machines --restricted --projects t3-machines",
].join("\n");
