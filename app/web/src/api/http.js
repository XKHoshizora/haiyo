// The one place that talks to the service over HTTP. Same-origin, cookie session, JSON in and out.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when no response arrived (network failure).
   * @param {string} code the service's snake_case `error` code.
   * @param {string|null} reason the service's optional `reason` detail.
   * @param {{resetsAt?: string|null, agents?: {id: string, name: string}[]|null}} [details] the other details a client
   *   shows: `resetsAt` of `no_quota`, the `agents` of `provider_in_use` (null when absent).
   */
  constructor(status, code, reason = null, details = {}) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.resetsAt = details?.resetsAt ?? null;
    this.agents = details?.agents ?? null;
    /** The room still free, in characters, of a 409 `room_full`. */
    this.left = Number.isFinite(details?.left) ? details.left : null;
    /** True on a 409 `room_full` that refused for the room's number of notes (`left` is then still the weight really left). */
    this.count = details?.count === true;
    /** When a 429 `handle_change_too_soon` says the handle may change again (an ISO time). */
    this.availableAt = typeof details?.availableAt === "string" ? details.availableAt : null;
  }
}

const AUTH_PREFIX = "/api/auth/";
let onUnauthenticated = null;
let onTermsRequired = null;
let onAccountChanged = null;
let sessionEpoch = 0;
/** The account this page runs for (the sign-in gate's), named on every request (`X-Account`); null: none yet, or signed out. */
let account = null;
/** The header that names the account a request is made for (app/service/README.md, Sessions). */
export const ACCOUNT_HEADER = "X-Account";

/**
 * The account the page's data layer runs for (AuthRoot `confirm`), or null (signed out). Every request names it: the service answers a
 * request for another account than its session's — someone else signed in in this browser since — with 409 `account_changed` and
 * nothing of that other account's (T2 fix 3, S1). Such an answer reaches the handler (`setAccountChangedHandler`), and the request
 * never settles: nothing of it is applied anywhere, and no error is shown (the page is being given to the account that is signed in).
 */
export function setAccount(id) {
  account = typeof id === "string" ? id : null;
}

/** Registers the function called for a 409 `account_changed` of this session (see `setAccount`). Pass null to clear. */
export function setAccountChangedHandler(fn) {
  onAccountChanged = typeof fn === "function" ? fn : null;
}

/** The headers naming the account (none when no account is set, or `anyAccount`: the sign-in gate's own reading of who is signed in). */
const accountHeaders = (options) => (account !== null && !options?.anyAccount ? { [ACCOUNT_HEADER]: account } : {});

/** A 409 `account_changed`: the handler is told (once per answer, of this session only), and the caller's promise never settles. */
function accountChanged(epoch) {
  if (epoch === sessionEpoch && onAccountChanged) {
    try {
      onAccountChanged();
    } catch {
      /* the handler must not throw into the request */
    }
  }
  return new Promise(() => {});
}
const isAccountChanged = (status, data) => status === 409 && data?.error === "account_changed";

/**
 * Registers the function called for every 403 `terms_required` of this session (the service's answer to any signed-in
 * request while the account has not accepted the terms and the privacy policy in force). Pass null to clear.
 */
export function setTermsRequiredHandler(fn) {
  onTermsRequired = typeof fn === "function" ? fn : null;
}

/** A new session or the end of one: 401s of requests that started before this are about the old session. */
export function bumpSessionEpoch() {
  sessionEpoch += 1;
}

/**
 * Registers the function called once for every 401 response. Pass null to clear. 401s from `/api/auth/*` never
 * reach it: a wrong password or a spent reset token is not an ended session.
 */
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = typeof fn === "function" ? fn : null;
}

async function readJson(res) {
  try {
    return parseJson(await res.text());
  } catch {
    // The body was cut while it was read (a reload mid-answer, a dropped connection): a network failure like a failed fetch, as an ApiError.
    return cut();
  }
}

/**
 * Once the page is going away (`pagehide`: a reload, a close, leaving for another page) the browser aborts what is in flight, and an answer
 * nobody will read is no failure: such a request stays pending (the page that asked is gone with it). A page restored from the back/forward cache
 * (`pageshow`) is alive again. Outside that, a failed request is a failure — never swallowed.
 */
let leaving = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    leaving = true;
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
}
const cut = () => {
  if (leaving) return new Promise(() => {});
  throw new ApiError(0, "network_error");
};

/**
 * @param {string} method
 * @param {string} path absolute path starting with /api
 * @param {unknown} [body] sent as JSON when given; no body and no content type otherwise
 * @param {{signal?: AbortSignal, anyAccount?: boolean}} [options] `signal` ends the request early (the caller that aborts is not waiting
 *   for it any more); `anyAccount` names no account (`setAccount`): only the sign-in gate's reading of who is signed in
 * @returns the parsed JSON body (null when empty)
 */
export async function request(method, path, body, options) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json", ...accountHeaders(options) } };
  if (options?.signal) init.signal = options.signal;
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const epoch = sessionEpoch;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return cut();
  }

  const data = await readJson(res);
  if (res.ok) return data;
  if (isAccountChanged(res.status, data)) return accountChanged(epoch);

  throw apiErrorOf(res.status, data, path, epoch);
}

/**
 * Sends raw bytes (a File or Blob) as the body, e.g. `PUT /api/me/avatar`. Same origin, cookie session; the answer
 * is JSON as in `request`.
 * @param {string} method
 * @param {string} path absolute path starting with /api
 * @param {Blob} body
 * @param {string} contentType
 */
export async function requestBytes(method, path, body, contentType) {
  const epoch = sessionEpoch;
  let res;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": contentType, ...accountHeaders() }, body });
  } catch {
    return cut();
  }
  const data = await readJson(res);
  if (res.ok) return data;
  if (isAccountChanged(res.status, data)) return accountChanged(epoch);
  throw apiErrorOf(res.status, data, path, epoch);
}

/** The ApiError for a non-2xx answer; a 401 on a non-auth path first reaches the registered handler. */
function apiErrorOf(status, data, path, epoch) {
  const code = typeof data?.error === "string" ? data.error : "unknown";
  const reason = typeof data?.reason === "string" ? data.reason : null;
  const resetsAt = typeof data?.resetsAt === "string" ? data.resetsAt : null;
  const agents = Array.isArray(data?.agents)
    ? data.agents.filter((a) => a && typeof a.id === "string" && typeof a.name === "string").map((a) => ({ id: a.id, name: a.name }))
    : null;
  const left = Number.isFinite(data?.left) ? data.left : null;
  const availableAt = typeof data?.availableAt === "string" ? data.availableAt : null;
  const error = new ApiError(status, code, reason, { resetsAt, agents, left, count: data?.count === true, availableAt });
  if (status === 401 && onUnauthenticated && epoch === sessionEpoch && !path.startsWith(AUTH_PREFIX)) {
    try {
      onUnauthenticated(error);
    } catch {
      /* the handler must never replace the ApiError */
    }
  }
  if (status === 403 && code === "terms_required" && onTermsRequired && epoch === sessionEpoch) {
    try {
      onTermsRequired(error);
    } catch {
      /* as above */
    }
  }
  return error;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * POSTs a FormData (a multipart upload) with progress. Same origin, so the session cookie goes along; no
 * Content-Type is set (the browser adds the multipart boundary). Errors are ApiErrors as in `request`;
 * aborting through `signal` rejects with `ApiError(0, "aborted")`.
 * @param {string} path absolute path starting with /api
 * @param {FormData} form
 * @param {{onProgress?: (fraction: number) => void, signal?: AbortSignal}} [options]
 * @returns the parsed JSON body
 */
export function upload(path, form, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, "aborted"));
      return;
    }
    const epoch = sessionEpoch;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("Accept", "application/json");
    for (const [name, value] of Object.entries(accountHeaders())) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      const data = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else if (isAccountChanged(xhr.status, data)) accountChanged(epoch);
      else reject(apiErrorOf(xhr.status, data, path, epoch));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error"));
    xhr.onabort = () => reject(new ApiError(0, "aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
