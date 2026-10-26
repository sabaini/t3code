// @effect-diagnostics nodeBuiltinImport:off - Synchronous hashing for LXD names; Effect's Crypto is effectful.
// @effect-diagnostics preferSchemaOverJson:off - JSON string literals quote values safely in generated YAML.
import * as NodeCrypto from "node:crypto";

import type { MachineProfile } from "@t3tools/contracts";

import type { LxdInstancesPost, LxdNetworkAclPut } from "./lxd/LxdClient.ts";

/**
 * Machines run whatever agents put on them. Each thread's machines get an OVN
 * network of their own, where they reach each other and the public internet,
 * and nothing else: not the LAN, the tailnet, or the T3 host. That needs an LXD
 * project whose certificate can make such networks but can't hand out the host.
 */

/** The ACL every thread's network uses. Its `@internal` means the machines on that network. */
export const MACHINE_NETWORK_ACL = "t3-machines";
/** LXD's default `dns.domain`: machines reach each other as `<instance>.lxd`. */
export const MACHINE_DNS_DOMAIN = "lxd";

/** Two T3 environments may share an LXD project; each only ever touches its own machines. */
const MACHINE_TAG_ENVIRONMENT = "user.t3.environment";
const MACHINE_TAG_THREAD = "user.t3.thread";
const MACHINE_TAG_LEASE = "user.t3.lease";

/** The tags of an instance this environment made, or undefined for any other instance. */
export const machineInstanceTags = (
  environmentId: string,
  config: Readonly<Record<string, string>>,
) =>
  config[MACHINE_TAG_ENVIRONMENT] === environmentId
    ? { threadId: config[MACHINE_TAG_THREAD], leaseId: config[MACHINE_TAG_LEASE] }
    : undefined;

const threadSuffix = (threadId: string) =>
  NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 8);

/** LXD network names have at most 15 characters. */
export const threadNetworkName = (threadId: string) => `t3m-${threadSuffix(threadId)}`;

/** LXD names are per project, so each thread's machines carry a suffix of their own. */
export const machineInstanceName = (threadId: string, name: string) =>
  `${name}-${threadSuffix(threadId)}`;

/** Special-purpose IPv4 ranges machines never reach. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT, Tailscale tailnets
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918 private, Docker bridges
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918 private, most LANs
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
];

const ipv4Number = (address: string) =>
  address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
const ipv4Address = (value: number) =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");

/** Every IPv4 address outside the blocked ranges, as the fewest CIDR blocks: OVN allow lists can't subtract. */
export function publicIpv4Cidrs(): ReadonlyArray<string> {
  const blocked = BLOCKED_IPV4_RANGES.map(
    ([address, prefix]) => [ipv4Number(address), ipv4Number(address) + 2 ** (32 - prefix)] as const,
  ).toSorted((a, b) => a[0] - b[0]);
  const cidrs: Array<string> = [];
  // Each step takes the largest block that starts on its own boundary and stays inside the gap.
  const cover = (start: number, end: number) => {
    while (start < end) {
      let size = 1;
      while (start % (size * 2) === 0 && start + size * 2 <= end) size *= 2;
      cidrs.push(`${ipv4Address(start)}/${32 - Math.log2(size)}`);
      start += size;
    }
  };
  let next = 0;
  for (const [start, end] of blocked) {
    cover(next, start);
    next = Math.max(next, end);
  }
  cover(next, 2 ** 32);
  return cidrs;
}

export function machineNetworkAclRules(): LxdNetworkAclPut {
  return {
    description: "T3 Code machines reach each other and the public internet",
    egress: [
      { action: "allow", destination: "@internal", state: "enabled" },
      { action: "allow", destination: publicIpv4Cidrs().join(","), state: "enabled" },
    ],
    ingress: [{ action: "allow", source: "@internal", state: "enabled" }],
  };
}

/** What keeps a thread's network sandboxed. */
export const THREAD_NETWORK_SECURITY: Readonly<Record<string, string>> = {
  // There's no IPv6 to filter.
  "ipv6.address": "none",
  "security.acls": MACHINE_NETWORK_ACL,
  // OVN applies reject rules before allow rules, so rejecting private ranges
  // would also cut machines off from each other. The ACL lists what's allowed
  // and the default refuses the rest. LXD still allows DHCP, and DNS to the
  // uplink's resolvers.
  "security.acls.default.egress.action": "reject",
  "security.acls.default.ingress.action": "reject",
};

/** LXD 6.9 is the first to restore a VM snapshot more than once in a restricted project. */
export function lxdVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 6 || (major === 6 && minor >= 9);
}

/** `restricted.*` settings that may be `allow` without handing out the LXD host. */
const HARMLESS_ALLOWS = new Set([
  "restricted.snapshots",
  "restricted.backups",
  "restricted.cluster.target",
  "restricted.containers.interception",
]);

export interface ProjectSandbox {
  /** The one OVN uplink the project may use, which thread networks use. */
  readonly uplink: string | undefined;
  /** Settings the project needs, as `key=value`. */
  readonly missing: ReadonlyArray<string>;
  /** Settings that hand out the LXD host or its devices. */
  readonly unsafe: ReadonlyArray<string>;
}

/** Machines are only created in a project that keeps them sandboxed. */
export function projectSandbox(config: Readonly<Record<string, string>>): ProjectSandbox {
  const missing: Array<string> = [];
  if (config.restricted !== "true") missing.push("restricted=true");
  if (config["restricted.snapshots"] !== "allow") missing.push("restricted.snapshots=allow");
  // With the default project's images, its certificate could change images other projects use.
  if (config["features.images"] !== "true") missing.push("features.images=true");
  // LXD restricts only projects with profiles of their own.
  if (config["features.profiles"] !== "true") missing.push("features.profiles=true");
  if (config["features.networks"] !== "true") missing.push("features.networks=true");
  const uplinks = (config["restricted.networks.uplinks"] ?? "")
    .split(",")
    .map((uplink) => uplink.trim())
    .filter(Boolean);
  if (uplinks.length !== 1) missing.push("restricted.networks.uplinks=UPLINK");
  const unsafe = Object.entries(config)
    .filter(
      ([key, value]) =>
        key.startsWith("restricted.") &&
        ((value === "allow" && !HARMLESS_ALLOWS.has(key)) ||
          (key === "restricted.containers.interception" && value === "full") ||
          // Host user and group IDs a container may map.
          (key.startsWith("restricted.idmap.") && value !== "")),
    )
    .map(([key]) => key)
    .toSorted();
  return { uplink: uplinks.length === 1 ? uplinks[0] : undefined, missing, unsafe };
}

const IMAGE_SERVERS: Readonly<Record<string, string>> = {
  ubuntu: "https://cloud-images.ubuntu.com/releases",
  "ubuntu-daily": "https://cloud-images.ubuntu.com/daily",
};

/** `MachineImage` only admits the servers above, or a bare alias on the LXD server. */
export function machineImageSource(image: string): LxdInstancesPost["source"] {
  const separator = image.indexOf(":");
  const server = separator < 0 ? undefined : IMAGE_SERVERS[image.slice(0, separator)];
  if (server === undefined) return { type: "image", alias: image };
  return { type: "image", alias: image.slice(separator + 1), server, protocol: "simplestreams" };
}

/** JSON strings are valid YAML, so the name and key need no further quoting. */
const machineVendorData = (name: string, publicKey: string) =>
  `#cloud-config\nhostname: ${JSON.stringify(name)}\nmanage_etc_hosts: true\nssh_authorized_keys:\n  - ${JSON.stringify(publicKey)}\n`;

export const machineInstanceConfig = (input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly leaseId: string;
  readonly name: string;
  readonly profile: MachineProfile;
  readonly publicKey: string;
}): Readonly<Record<string, string>> => ({
  [MACHINE_TAG_ENVIRONMENT]: input.environmentId,
  [MACHINE_TAG_THREAD]: input.threadId,
  [MACHINE_TAG_LEASE]: input.leaseId,
  "cloud-init.vendor-data": machineVendorData(input.name, input.publicKey),
  "limits.cpu": String(input.profile.cpus),
  "limits.memory": `${input.profile.memoryGiB}GiB`,
  // MicroCloud turns stateful migration on for every VM, and then refuses extra
  // disks from local pools. Machines never move.
  ...(input.profile.type === "virtual-machine" ? { "migration.stateful": "false" } : {}),
});
