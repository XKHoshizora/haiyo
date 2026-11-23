import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";

/**
 * What others' use of my Agents has cost today against my two numbers (`GET /api/me/others-use`), read when the page opens: the
 * route's answer as it came (`use`), or null before it, and `failed` when it could not be read (a 401 signs out as everywhere;
 * nothing is held anywhere else). `reload()` reads it again; `settle(answer)` takes a newer answer (a save returns the same shape).
 * Nothing of it is computed here: the numbers, the three states and the notice are the service's.
 */
export function useOthersUse() {
  const { actions } = useStore();
  const [use, setUse] = useState(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const reading = useRef(0);
  const load = useCallback(async () => {
    const mine = ++reading.current;
    try {
      const answer = await actions.getOthersUse();
      if (!alive.current || mine !== reading.current) return;
      if (answer && typeof answer === "object" && answer.limits) {
        setUse(answer);
        setFailed(false);
      } else setFailed(true);
    } catch {
      if (alive.current && mine === reading.current) setFailed(true);
    }
  }, [actions]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  return { use, failed, reload: load, settle: setUse };
}
