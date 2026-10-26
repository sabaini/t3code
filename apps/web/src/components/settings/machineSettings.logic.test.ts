import { describe, expect, it } from "vite-plus/test";

import {
  machineProfileDraft,
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
