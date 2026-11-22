// @vitest-environment jsdom
// A request cut by the page going away (a reload while /api/sync is being read): what the browser aborts is swallowed, a real failure never is.
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../src/api/http.js";

const settled = async (promise) => {
  let state = "pending";
  promise.then(
    () => (state = "resolved"),
    () => (state = "rejected"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return state;
};
const cutBody = () => ({ ok: true, status: 200, text: async () => Promise.reject(new TypeError("Load failed")) });
afterEach(() => {
  window.dispatchEvent(new Event("pageshow"));
  vi.unstubAllGlobals();
});

describe("a request cut by the page going away", () => {
  it("a fetch that fails while the page is not going away is a network_error, as ever (a real failure is never hidden)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Load failed"))));
    await expect(request("GET", "/api/sync")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("a response whose body is cut while it is read is a network_error too — an ApiError, not a bare TypeError that nothing expects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => cutBody()));
    await expect(request("GET", "/api/sync")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("once the page is hiding (pagehide: a reload or a close), what the browser aborts stays pending — nothing rejects in a page that is going; pageshow makes failures real again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Load failed"))));
    window.dispatchEvent(new Event("pagehide"));
    expect(await settled(request("GET", "/api/sync"))).toBe("pending");
    vi.stubGlobal("fetch", vi.fn(async () => cutBody()));
    expect(await settled(request("GET", "/api/sync"))).toBe("pending");
    window.dispatchEvent(new Event("pageshow"));
    await expect(request("GET", "/api/sync")).rejects.toMatchObject({ code: "network_error" });
  });
});
