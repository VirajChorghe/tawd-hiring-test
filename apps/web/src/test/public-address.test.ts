import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isPrivateAddress, publicOnlyLookup } from "@tawd/core/public-address";

describe("isPrivateAddress", () => {
  it("refuses private, loopback and link-local addresses, IPv4 and IPv6", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses IPv4 written inside IPv6, in the dotted and the hex form", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0a00:0001", "64:ff9b::10.0.0.1", "64:ff9b::a00:1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "::ffff:5db8:d822", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("publicOnlyLookup", () => {
  it("refuses to connect when the name answers a private address, at the moment of connecting", async () => {
    let served = 0;
    const server = http.createServer((_req, res) => {
      served += 1;
      res.end("inside");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        http.get(`http://localhost:${port}/`, { lookup: publicOnlyLookup }, () => resolve(null)).on("error", resolve);
      });
      expect(error?.code).toBe("EPRIVATE");
      expect(served).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("isPrivateAddress: the IPv6 forms that carry or stand in for an IPv4 or private address (F-048)", () => {
  it("refuses 6to4 wrapping a private IPv4, and lets 6to4 wrapping a public one through", () => {
    for (const ip of ["2002:7f00:1::", "2002:7f00:0001::1", "2002:0a00:1::", "2002:c0a8:101::", "2002:a9fe:a9fe::5", "2002:7f00:1:0:0:0:0:0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("2002:5db8:d822::1")).toBe(false);
  });

  it("refuses the deprecated site-local range fec0::/10", () => {
    for (const ip of ["fec0::1", "FEC0::1", "fed0::1", "feff::1", "fec0:0:0:1::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses NAT64 (64:ff9b::/96) wrapping a private IPv4, in every spelling, and lets a public one through", () => {
    for (const ip of ["64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b:0:0:0:0:7f00:1", "64:ff9b:0000:0000:0000:0000:a9fe:a9fe", "64:ff9b::0a00:0001"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("64:ff9b::5db8:d822")).toBe(false);
    expect(isPrivateAddress("64:ff9b::93.184.216.34")).toBe(false);
  });

  it("refuses Teredo (2001::/32) to be safe, but not other 2001: addresses", () => {
    for (const ip of ["2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:0000::5"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("still refuses what it refused before, and a zone id doesn't hide it", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["2606:4700::1111", "2a00:1450:4001::200e"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("VML's own servers count as private to TAWD (Fable's review of #81)", () => {
  it("refuses TAWD's droplet and the Coolify server, in every spelling", () => {
    for (const ip of [
      "203.0.113.10",
      "203.0.113.20",
      "::ffff:203.0.113.10",
      "::ffff:cb00:710a",
      "64:ff9b::cb00:710a",
      "2001:db8::10",
      "2001:0DB8:0000:0000:0000:0000:0000:0010",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("still lets their neighbours through", () => {
    for (const ip of ["203.0.113.11", "203.0.113.21", "2001:db8::11"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
