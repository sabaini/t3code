import type { MachineHostsInspection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  machineProfileDraft,
  machineHostsAttention,
  machineProjectFixCommands,
  NEW_MACHINE_PROFILE_DRAFT,
  parseMachineProfileDraft,
} from "./machineSettings.logic";

describe("parseMachineProfileDraft", () => {
  it("reads a profile from the form, defaulting its LXD profiles", () => {
    const parsed = parseMachineProfileDraft(
      { ...NEW_MACHINE_PROFILE_DRAFT, name: "ceph", disks: "20, 20 ,", lxdProfiles: " " },
      [],
    );
    expect(parsed).toEqual({
      profile: {
        name: "ceph",
        type: "virtual-machine",
        image: "ubuntu:24.04",
        cpus: 2,
        memoryGiB: 2,
        diskSizesGiB: [20, 20],
        lifetimeHours: 24,
        lxdProfiles: ["default"],
      },
    });
    if ("profile" in parsed) {
      expect(machineProfileDraft(parsed.profile)).toMatchObject({ disks: "20, 20" });
    }
  });

  it("says what to fix", () => {
    const draft = { ...NEW_MACHINE_PROFILE_DRAFT, name: "web" };
    expect(parseMachineProfileDraft({ ...draft, name: "Web" }, [])).toHaveProperty("error");
    expect(parseMachineProfileDraft(draft, ["web"])).toEqual({
      error: "There's a profile called web already.",
    });
    expect(parseMachineProfileDraft({ ...draft, image: "images:debian/12" }, [])).toHaveProperty(
      "error",
    );
    expect(parseMachineProfileDraft({ ...draft, type: "container", disks: "4" }, [])).toEqual({
      error: "Only virtual machines can have extra disks.",
    });
    expect(parseMachineProfileDraft({ ...draft, disks: "4, big" }, [])).toHaveProperty("error");
    expect(parseMachineProfileDraft({ ...draft, cpus: "0" }, [])).toHaveProperty("error");
  });
});

it("turns a project's missing and unsafe settings into lxc commands", () => {
  expect(
    machineProjectFixCommands("t3-machines", {
      missing: ["features.images=true", "restricted.networks.uplinks=UPLINK"],
      unsafe: ["restricted.devices.disk"],
    }),
  ).toEqual([
    "lxc project set t3-machines features.images=true restricted.networks.uplinks=UPLINK",
    "lxc project unset t3-machines restricted.devices.disk",
  ]);
});

it("machineHostsAttention warns about broken servers and stray machines, and is quiet otherwise", () => {
  const status = {
    serverName: "trurl",
    version: "6.10",
    versionSupported: true,
    instanceTypes: ["container"],
    missing: [],
    unsafe: [],
  };
  const stray = { hostId: "lxd-1", instance: "box-1-abc", type: "container", status: "Stopped" };
  const cases: ReadonlyArray<MachineHostsInspection & { expected: string | null }> = [
    { hosts: [{ hostId: "lxd-1", status }], untracked: [], expected: null },
    { hosts: [{ hostId: "lxd-1" }], untracked: [], expected: null },
    {
      hosts: [{ hostId: "lxd-1", status: { ...status, versionSupported: false } }],
      untracked: [stray],
      expected: "Needs attention · 1 machine without a thread",
    },
    {
      hosts: [
        { hostId: "lxd-1", error: "Couldn't reach the LXD server at 10.0.0.70:8443." },
        { hostId: "lxd-2", status: { ...status, unsafe: ["restricted.devices.disk"] } },
      ],
      untracked: [stray, stray],
      expected: "2 need attention · 2 machines without a thread",
    },
  ];
  for (const { expected, ...inspection } of cases) {
    expect(machineHostsAttention(inspection)).toBe(expected);
  }
});
