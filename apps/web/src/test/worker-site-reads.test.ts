import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { pinnedRequest } from "../../../worker/src/read-limited";

/*
  The worker's reads of a client's site connect only to the address that
  was checked (14 October 2026, the whole-code review): a name that answers
  a private address when the connection is made is refused right then.
*/

describe("the worker's site reads", () => {
  it("never connect to a name that points at a private address", async () => {
    let served = 0;
    const server = http.createServer((_req, res) => {
      served += 1;
      res.end("inside");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(pinnedRequest(5_000, {})(`http://localhost:${port}/`)).rejects.toThrow("private network");
      expect(served).toBe(0);
    } finally {
      server.close();
    }
  });
});
