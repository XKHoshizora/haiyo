import net from "node:net";
import { describe, expect, it } from "vitest";
import { applyConnectTuning, CONNECT_ATTEMPT_TIMEOUT_MS } from "../src/net-tuning.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Node connects to a host's addresses one at a time and gives each only 250 ms by default: a provider whose TCP handshake
 * takes longer from our region (measured on the acceptance server: 330 ms and 1343 ms to a mainland-China host) could never
 * be reached. The allowance is raised once, when the app is built. (A delayed TCP accept cannot be simulated portably in
 * the harness, so the setting itself is pinned, and that family auto-selection stays on.)
 */
describe("the connection-attempt allowance", () => {
  useApp();

  it("is 3000 ms once the app is built, and address families are still auto-selected", () => {
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBe(3000);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
  });

  it("applyConnectTuning itself sets it (not only the app's build: this does not depend on module state)", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    applyConnectTuning();
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(3000);
  });
});
