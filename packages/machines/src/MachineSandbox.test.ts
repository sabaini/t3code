import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";

import {
  lxdVersionSupported,
  machineImageSource,
  projectSandbox,
  publicIpv4Cidrs,
} from "./MachineSandbox.ts";

const SANDBOXED = {
  restricted: "true",
  "restricted.snapshots": "allow",
  "features.images": "true",
  "features.profiles": "true",
  "features.networks": "true",
  "restricted.networks.uplinks": "uplink0",
};

describe("projectSandbox", () => {
  it("accepts a restricted project with one uplink", () => {
    expect(projectSandbox(SANDBOXED)).toEqual({ uplink: "uplink0", missing: [], unsafe: [] });
  });

  it("names what an unrestricted project lacks", () => {
    expect(projectSandbox({ "features.profiles": "true" }).missing).toEqual([
      "restricted=true",
      "restricted.snapshots=allow",
      "features.images=true",
      "features.networks=true",
      "restricted.networks.uplinks=UPLINK",
    ]);
  });

  it("refuses more than one uplink", () => {
    const sandbox = projectSandbox({ ...SANDBOXED, "restricted.networks.uplinks": "a, b" });
    expect(sandbox.uplink).toBeUndefined();
    expect(sandbox.missing).toEqual(["restricted.networks.uplinks=UPLINK"]);
  });

  it("flags settings that hand out the host", () => {
    expect(
      projectSandbox({
        ...SANDBOXED,
        "restricted.devices.disk": "allow",
        "restricted.containers.interception": "full",
        "restricted.idmap.uid": "0",
        "restricted.backups": "allow",
      }).unsafe,
    ).toEqual([
      "restricted.containers.interception",
      "restricted.devices.disk",
      "restricted.idmap.uid",
    ]);
  });
});

describe("publicIpv4Cidrs", () => {
  const allowed = new NodeNet.BlockList();
  for (const cidr of publicIpv4Cidrs()) {
    const [address, prefix] = cidr.split("/");
    allowed.addSubnet(address!, Number(prefix), "ipv4");
  }

  it("covers public addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "91.189.91.38", "223.255.255.255"]) {
      expect(allowed.check(address, "ipv4"), address).toBe(true);
    }
  });

  it("leaves out private, tailnet, link-local and loopback ranges", () => {
    for (const address of [
      "10.0.0.70",
      "100.100.100.100",
      "169.254.169.254",
      "127.0.0.1",
      "172.17.0.1",
      "192.168.1.1",
      "255.255.255.255",
    ]) {
      expect(allowed.check(address, "ipv4"), address).toBe(false);
    }
  });
});

describe("lxdVersionSupported", () => {
  it("needs LXD 6.9 or later", () => {
    expect(lxdVersionSupported("5.21.3")).toBe(false);
    expect(lxdVersionSupported("6.8")).toBe(false);
    expect(lxdVersionSupported("6.9")).toBe(true);
    expect(lxdVersionSupported("6.10.0")).toBe(true);
    expect(lxdVersionSupported("7.0")).toBe(true);
  });
});

describe("machineImageSource", () => {
  it("maps the public image servers and keeps local aliases", () => {
    expect(machineImageSource("ubuntu:24.04")).toEqual({
      type: "image",
      alias: "24.04",
      server: "https://cloud-images.ubuntu.com/releases",
      protocol: "simplestreams",
    });
    expect(machineImageSource("ubuntu-daily:noble")).toMatchObject({
      alias: "noble",
      server: "https://cloud-images.ubuntu.com/daily",
    });
    expect(machineImageSource("my-golden-image")).toEqual({
      type: "image",
      alias: "my-golden-image",
    });
  });
});
