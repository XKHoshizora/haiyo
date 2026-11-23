import { describe, expect, it, vi } from "vitest";
import { CLOSE_STALE, CONNECT_MS, PING_MS, openSocket } from "../src/api/socket.js";
import { fakeTimers, settle } from "./fixtures.js";

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code) {
    this.closedWith = code ?? null;
  }
  // test side
  serverOpen() {
    this.onopen?.({});
  }
  serverSend(data) {
    this.onmessage?.({ data });
  }
  serverClose(code) {
    this.onclose?.({ code });
  }
}

function setup() {
  FakeWebSocket.instances = [];
  const timers = fakeTimers();
  const onEvent = vi.fn();
  const onClose = vi.fn();
  const requestTicket = vi.fn(async () => ({ ticket: "tk+1" }));
  const opening = openSocket({
    requestTicket,
    urlFor: (ticket) => `ws://host/api/ws?ticket=${encodeURIComponent(ticket)}`,
    WebSocketImpl: FakeWebSocket,
    timers,
    onEvent,
    onClose,
  });
  return { timers, onEvent, onClose, requestTicket, opening };
}

describe("openSocket", () => {
  it("gets a ticket, opens the socket with it and resolves once open", async () => {
    const { opening, requestTicket } = setup();
    await settle();
    expect(requestTicket).toHaveBeenCalledTimes(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://host/api/ws?ticket=tk%2B1");
    ws.serverOpen();
    const handle = await opening;
    expect(typeof handle.close).toBe("function");
  });

  it("passes JSON pushes on, drops pongs and anything malformed", async () => {
    const { opening, onEvent } = setup();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    await opening;
    ws.serverSend(JSON.stringify({ type: "social" }));
    ws.serverSend(JSON.stringify({ type: "pong" }));
    ws.serverSend("not json");
    ws.serverSend(JSON.stringify([1, 2]));
    ws.serverSend(new ArrayBuffer(2));
    expect(onEvent.mock.calls).toEqual([[{ type: "social" }]]);
  });

  it("pings every 25 s and gives up on a socket that stayed silent for a whole interval", async () => {
    const { opening, timers, onClose } = setup();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    await opening;
    expect(PING_MS).toBe(25_000);
    timers.advance(PING_MS);
    expect(ws.sent).toEqual([JSON.stringify({ type: "ping" })]);
    ws.serverSend(JSON.stringify({ type: "pong" }));
    timers.advance(PING_MS);
    expect(ws.sent).toHaveLength(2);
    expect(onClose).not.toHaveBeenCalled();
    timers.advance(PING_MS); // no answer to the second ping
    expect(onClose).toHaveBeenCalledWith(CLOSE_STALE);
    expect(ws.closedWith).toBe(1000);
    expect(timers.pending()).toBe(0);
    ws.serverClose(1006); // the late close event is not reported again
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports the close code once and stops pinging", async () => {
    const { opening, timers, onClose } = setup();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    await opening;
    ws.serverClose(4002);
    expect(onClose).toHaveBeenCalledWith(4002);
    expect(timers.pending()).toBe(0);
  });

  it("close() stops everything without reporting a close", async () => {
    const { opening, timers, onClose } = setup();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const handle = await opening;
    handle.close();
    expect(ws.closedWith).toBe(1000);
    expect(timers.pending()).toBe(0);
    ws.serverClose(1000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects with the close code when the socket closes before opening", async () => {
    const { opening, onClose } = setup();
    await settle();
    FakeWebSocket.instances[0].serverClose(1006);
    await expect(opening).rejects.toMatchObject({ code: 1006 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects with the ticket request's error", async () => {
    const err = new Error("unauthenticated");
    const opening = openSocket({
      requestTicket: async () => {
        throw err;
      },
      urlFor: () => "ws://x",
      WebSocketImpl: FakeWebSocket,
      timers: fakeTimers(),
      onEvent() {},
      onClose() {},
    });
    await expect(opening).rejects.toBe(err);
  });
});

describe("a connection that never opens", () => {
  // README (the iOS shell): an iOS 26 WebSocket can hang in CONNECTING after a resume; the attempt must end so that the caller retries.
  it("is given up after the connect timeout: the promise rejects, the socket is closed, nothing is left running", async () => {
    const { timers, opening } = setup();
    const caught = opening.catch((e) => e);
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(1);
    timers.advance(CONNECT_MS + 1);
    const error = await caught;
    expect(error.name).toBe("SocketClosedError");
    expect(FakeWebSocket.instances[0].closedWith).not.toBeNull();
    expect(timers.pending()).toBe(0);
  });

  it("an open before the timeout cancels it", async () => {
    const { timers, opening } = setup();
    await settle();
    FakeWebSocket.instances[0].serverOpen();
    await opening;
    timers.advance(CONNECT_MS + 1);
    expect(FakeWebSocket.instances[0].closedWith).toBeNull();
  });
});

describe("the connect timeout and a real close", () => {
  it("a close before the open clears the timeout (nothing left running), and the sync engine plans its back-off retry on the rejection", async () => {
    const { timers, opening } = setup();
    const caught = opening.catch((e) => e);
    await settle();
    FakeWebSocket.instances[0].serverClose(1006);
    expect((await caught).name).toBe("SocketClosedError");
    expect(timers.pending()).toBe(0);
  });
});
