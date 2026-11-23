import net from "node:net";

/**
 * How long Node waits for ONE address of a host to accept a connection before it tries the next (happy eyeballs,
 * `net.setDefaultAutoSelectFamilyAttemptTimeout`; Node's default is 250 ms). Measured from the acceptance server
 * (asia-southeast1, Node 24): the TCP handshake to a mainland-China provider takes 330 ms and 1343 ms to its two IPv4
 * addresses, so with 250 ms every attempt was abandoned and `fetch` failed with ETIMEDOUT; with 5000 ms the same
 * request was answered. Applies to every outbound call of the process (model list, test, chat, web search).
 *
 * The real limits stay the callers' own: a provider probe is cut after `PROBE_DEADLINE_MS` (30 s, one signal for the
 * whole listing) and by the guard's 15 s without progress; a model call by its own idle timeout. Attempts at a host's
 * addresses are sequential, so one connection to a dead host takes at most (addresses) x 3 s before the guard's 15 s
 * `connect.timeout` ends it: with the usual two to four addresses, 6-12 s, never more than 15 s.
 * Family auto-selection itself is left on: IPv6-only and IPv4-only hosts both work.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 3000;

/** Applies the allowance process-wide; the app calls it as it is built, before any outbound call. */
export function applyConnectTuning(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
