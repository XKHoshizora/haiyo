import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { commonErrorText } from "../data/errorTexts.js";

/** An action's answer (`{ok, value}` or `{ok: false, error, text}`) as a value, or the refusal thrown (for `run`). */
export async function settled(pending) {
  const result = await pending;
  if (!result.ok) throw result;
  return result.value;
}

/** The sentence of a refusal thrown by `settled` (or of anything else that went wrong). */
export const refusalText = (error) => error?.text ?? commonErrorText(error);

/**
 * Runs one action at a time per key and says which is running (`busy`), so its button shows the pending state.
 * `run(key, work, textFor)` → `{ok: true, value}` or `{ok: false, error}`; a failure toasts `textFor(error)` (no toast when it is empty).
 */
export function useAction() {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const running = useRef(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async (key, work, textFor) => {
      if (running.current !== null) return { ok: false, error: { code: "busy_here" } };
      running.current = key;
      setBusy(key);
      try {
        const value = await work();
        return { ok: true, value };
      } catch (error) {
        const text = textFor(error);
        if (text) dispatch({ type: "toast", text });
        return { ok: false, error };
      } finally {
        running.current = null;
        if (alive.current) setBusy(null);
      }
    },
    [dispatch],
  );
  return { busy, run };
}

/**
 * The writes of a row that saves itself, one at a time: `pending` says one is running (or its follow-up, `after`, which
 * runs once the service took the write, is: the row stays locked until it returns); `error` is the sentence of the last
 * refusal, shown under the row (`setError` lets a row put its own there). `refused(res)` runs after a refusal.
 * `write(call)` runs an action and says whether the service took it. Nothing is toasted.
 */
export function useRowWrite({ after, refused } = {}) {
  const { busy, run } = useAction();
  const [error, setError] = useState("");
  const [settling, setSettling] = useState(false);
  const alive = useRef(true);
  const inflight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const write = async (call) => {
    if (inflight.current) return false;
    inflight.current = true;
    setError("");
    try {
      const res = await run("write", () => settled(call()), () => "");
      if (res.ok) {
        if (after) {
          setSettling(true);
          try {
            await after();
          } finally {
            if (alive.current) setSettling(false);
          }
        }
      } else if (res.error?.code !== "busy_here") {
        setError(refusalText(res.error));
        refused?.(res.error);
      }
      return res.ok;
    } finally {
      inflight.current = false;
    }
  };
  return { pending: busy !== null || settling, error, setError, write };
}

/** How often the page's one clock (`useNow`) moves on. */
const CLOCK_MS = 60 * 1000;
/** The one clock: its time, and who shows it. One interval runs while anything does; none while nothing does. */
const clock = { now: 0, timer: null, shown: new Set() };

function showClock(setNow) {
  if (clock.shown.size === 0) {
    clock.now = Date.now();
    clock.timer = window.setInterval(() => {
      clock.now = Date.now();
      for (const set of clock.shown) set(clock.now);
    }, CLOCK_MS);
  }
  clock.shown.add(setNow);
  // (Mounted in the same commit as the one that started it, or a moment after its last move: it reads the same time as the others.)
  setNow(clock.now);
  return () => {
    clock.shown.delete(setNow);
    if (clock.shown.size > 0) return;
    window.clearInterval(clock.timer);
    clock.timer = null;
  };
}

/**
 * The current time by the page's one clock, moved on every CLOCK_MS while the component is mounted (shown). Every time that counts down
 * reads it (the rail's number on 通讯录, the contacts list, a contact's card, the requests on my Agents): two of them never disagree about a
 * minute, however far apart they were mounted.
 */
export function useNow() {
  const [now, setNow] = useState(() => (clock.shown.size > 0 ? clock.now : Date.now()));
  useEffect(() => showClock(setNow), []);
  return now;
}
