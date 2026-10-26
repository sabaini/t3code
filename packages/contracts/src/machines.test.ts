import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { MachineHostConfig, MachineName, MachineProfiles } from "./machines.ts";
import { secretSettingsFields } from "./settings.ts";

const decodeProfiles = Schema.decodeUnknownSync(MachineProfiles);

describe("machine contracts", () => {
  it("fills in profile defaults", () => {
    expect(decodeProfiles([{ name: "box", image: "ubuntu:24.04", type: "container" }])).toEqual([
      {
        name: "box",
        image: "ubuntu:24.04",
        type: "container",
        lxdProfiles: ["default"],
        cpus: 2,
        memoryGiB: 2,
        diskSizesGiB: [],
        lifetimeHours: 24,
      },
    ]);
  });

  it("gives extra disks only to virtual machines", () => {
    expect(() =>
      decodeProfiles([
        { name: "box", image: "ubuntu:24.04", type: "container", diskSizesGiB: [4] },
      ]),
    ).toThrow("Only virtual machines can have extra disks.");
    expect(
      decodeProfiles([
        { name: "vm", image: "ubuntu:24.04", type: "virtual-machine", diskSizesGiB: [4] },
      ])[0]?.diskSizesGiB,
    ).toEqual([4]);
  });

  it("refuses duplicate profile names and unknown image servers", () => {
    const box = { name: "box", image: "ubuntu:24.04", type: "container" };
    expect(() => decodeProfiles([box, box])).toThrow("Machine profile names must be unique.");
    expect(() => decodeProfiles([{ ...box, image: "https://example.com:image" }])).toThrow();
    expect(() => decodeProfiles([{ ...box, image: "images:debian/12" }])).toThrow();
  });

  it("keeps machine names usable as ssh host names", () => {
    const decode = Schema.decodeUnknownSync(MachineName);
    expect(decode("db-1")).toBe("db-1");
    expect(() => decode("localhost")).toThrow("A machine can't be called localhost.");
    expect(() => decode("Web")).toThrow();
  });

  it("stores the LXD client key as a secret", () => {
    expect(secretSettingsFields(MachineHostConfig)).toEqual(["clientKey"]);
  });
});
