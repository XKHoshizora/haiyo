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
let sessionEpoch = 0;

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
  return parseJson(await res.text());
}

/**
 * @param {string} method
 * @param {string} path absolute path starting with /api
 * @param {unknown} [body] sent as JSON when given; no body and no content type otherwise
 * @returns the parsed JSON body (null when empty)
 */
export async function request(method, path, body) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const epoch = sessionEpoch;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network_error");
  }

  const data = await readJson(res);
  if (res.ok) return data;

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
    res = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": contentType }, body });
  } catch {
    throw new ApiError(0, "network_error");
  }
  const data = await readJson(res);
  if (res.ok) return data;
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
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      const data = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(apiErrorOf(xhr.status, data, path, epoch));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error"));
    xhr.onabort = () => reject(new ApiError(0, "aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
