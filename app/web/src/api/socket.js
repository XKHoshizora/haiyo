// The push socket: a one-time ticket, then a WebSocket on the page's own origin (app/service/README.md, "Socket").

/** We send `{"type":"ping"}` this often; the service answers `{"type":"pong"}`. */
export const PING_MS = 25_000;
/** Reported to `onClose` when nothing at all arrived during a whole ping interval (the network went away). */
export const CLOSE_STALE = 4900;
/** A socket that has not opened this long after it was made is given up (an iOS WebSocket can hang in CONNECTING after the app came back). */
export const CONNECT_MS = 15_000;

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/** The socket closed before it opened; `code` is its close code. */
export class SocketClosedError extends Error {
  constructor(code) {
    super(`socket closed before it opened (${code})`);
    this.name = "SocketClosedError";
    this.code = code;
  }
}

/**
 * Requests a ticket and opens the socket. Resolves once it is open with `{close()}`; rejects with the
 * ticket request's error or a `SocketClosedError`. After opening, every JSON push except `pong` goes to
 * `onEvent`, and the first close (code) goes to `onClose` once — never after `close()` was called.
 *
 * @param {object} o
 * @param {() => Promise<{ticket: string}>} o.requestTicket
 * @param {(ticket: string) => string} o.urlFor
 * @param {(event: object) => void} o.onEvent
 * @param {(code: number) => void} o.onClose
 */
export async function openSocket({ requestTicket, urlFor, WebSocketImpl = globalThis.WebSocket, timers = defaultTimers, pingMs = PING_MS, connectMs = CONNECT_MS, onEvent, onClose }) {
  const { ticket } = await requestTicket();
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(urlFor(ticket));
    let opened = false;
    let done = false;
    let timer = null;
    let heard = true;
    // The caller (sync.js) plans the next attempt when this rejects, as for any socket that closed before it opened.
    const hung = timers.setTimeout(() => {
      try {
        ws.close(1000);
      } catch {
        /* already closing */
      }
      finish(CLOSE_STALE);
    }, connectMs);

    const detach = () => {
      done = true;
      timers.clearTimeout(hung);
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    };
    const finish = (code) => {
      if (done) return;
      detach();
      if (opened) onClose(code);
      else reject(new SocketClosedError(code));
    };
    const tick = () => {
      if (!heard) {
        try {
          ws.close(1000);
        } catch {
          /* already closing */
        }
        finish(CLOSE_STALE);
        return;
      }
      heard = false;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* a close event follows */
      }
    };

    ws.onopen = () => {
      timers.clearTimeout(hung);
      opened = true;
      heard = true;
      timer = timers.setInterval(tick, pingMs);
      resolve({
        close() {
          if (done) return;
          detach();
          try {
            ws.close(1000);
          } catch {
            /* already closed */
          }
        },
      });
    };
    ws.onmessage = (e) => {
      heard = true;
      if (typeof e.data !== "string") return;
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") return;
      if (event.type === "pong") return;
      onEvent(event);
    };
    ws.onclose = (e) => finish(e?.code ?? 1006);
    ws.onerror = () => {
      /* the close event that follows says how it ended */
    };
  });
}
