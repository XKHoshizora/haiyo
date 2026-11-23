// Writes src/providers/model-catalog.json, the reduced snapshot of the models.dev catalogue that `modelHints`
// (src/providers/hints.ts) looks model names up in, src/providers/provider-catalog.json (the catalogue's providers by
// their API host, with their model ids: `catalogueModels`, src/providers/catalogue.ts), and their README (source, date,
// licence, entry count). Run by hand,
// `npm run catalog:update`: it downloads https://models.dev/models.json and https://models.dev/api.json, parses them
// as JSON (nothing in them is ever run) and keeps only what the snapshot needs. `npm run catalog:update -- <models.json>
// <api.json>` reads saved copies instead. The service itself never fetches the catalogue.
//
// Two flags, for the daily update (.github/workflows/catalog-update.yml): `--guard` refuses (exit 1, nothing written) a
// snapshot that, against the one on disk, shrank by more than 20 %, lost more than 5 % of the ids that had abilities,
// lost more than 20 % of one ability, or flipped one ability on more than 20 % of the models both have (`guardCatalog`),
// and a provider list that lost more than 20 % of its providers or model ids (`guardProviders`); `--summary=<file>` writes what changed against the one on disk (`catalogSummary`: models added,
// removed, abilities changed) to that file, for the commit message.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MODELS_URL = "https://models.dev/models.json";
export const API_URL = "https://models.dev/api.json";
/** Our own thinking levels above `none`, in order (src/config.ts `REASONING_LEVELS`). */
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];
/**
 * The catalogue's `type` of models that do not chat. Their modalities alone would not say so: an embedding model or a
 * reranker takes text and answers "text" (numbers), and a realtime model talks over its own socket API.
 */
const NOT_CHAT_TYPES = new Set(["embedding", "reranking", "speech", "transcription", "image", "video", "realtime"]);
/** What a model can do, as the snapshot's entry says it: the three it always carries, then the six kept only when true. */
export const ABILITIES = ["vision", "pdf", "reasoning", "tools", "audioIn", "videoIn", "imageOut", "videoOut", "audioOut"];
/** The most an update may shrink the snapshot by, and the most of the previous one's able ids it may lose (`guardCatalog`). */
export const GUARD = { maxShrink: 0.2, maxAbleLost: 0.05, maxAbilityLost: 0.2, maxAbilityFlipped: 0.2, minAbilityCount: 10 };
/** The longest lab or id kept (as a display name's limit): one short line each, since both are printed in summaries. */
const MAX_KEY_PART = 100;
/** How often a download is tried, and how long is waited between tries. */
const DOWNLOAD = { tries: 3, waitMs: 5_000 };
/** How many names of each kind a summary lists (`catalogSummary`). */
const SUMMARY_NAMES = 20;
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const CONTROL = /\p{Cc}/u;

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The thinking levels a first-party entry of api.json offers: the values of its `effort` option that are our levels,
 * in our order; none (undefined) for no entry, no `effort` option (a `toggle` or `budget_tokens` one: the gateway maps
 * any level onto those), or nothing left of it.
 */
export function levelsOf(entry) {
  const effort = (Array.isArray(entry?.reasoning_options) ? entry.reasoning_options : []).find((o) => o?.type === "effort");
  if (!effort) return undefined;
  const values = new Set(strings(effort.values));
  const levels = LEVELS.filter((level) => values.has(level));
  return levels.length > 0 ? levels : undefined;
}

/**
 * The snapshot: for each canonical model `lab/model-id` of models.json, `{id, lab, name, vision, pdf, reasoning, chat,
 * contextTokens?, reasoningLevels?, tools?, audioIn?, videoIn?, imageOut?, videoOut?, audioOut?}`, sorted by id (then
 * lab). `id` is the key's last segment in lower case; two labs may share it (both are kept). `reasoningLevels` comes
 * from the lab's own entry in api.json (`api[lab].models[id]`). The last six are there only as `true`: `tools` for the
 * catalogue's `tool_call: true`, `audioIn` / `videoIn` for audio / video among its input modalities, `imageOut` /
 * `videoOut` / `audioOut` for image / video / audio among its output modalities (absent: no, or not said).
 */
export function reduceCatalog(models, api = {}) {
  if (!isObject(models)) throw new Error("models.json: expected an object of models keyed lab/model-id");
  const out = [];
  for (const [key, entry] of Object.entries(models)) {
    if (!isObject(entry)) continue;
    const parts = key.split("/");
    const id = parts[parts.length - 1].trim().toLowerCase();
    const lab = parts.length > 1 ? parts[0] : "";
    // Not one short line each: left out (a lab or an id is printed in the update's summary and commit message).
    if (!id || CONTROL.test(id) || CONTROL.test(lab) || [...id].length > MAX_KEY_PART || [...lab].length > MAX_KEY_PART) continue;
    const input = strings(entry.modalities?.input);
    const output = strings(entry.modalities?.output);
    const label = typeof entry.name === "string" ? entry.name.trim() : "";
    const reduced = {
      id,
      lab,
      name: label && !CONTROL.test(label) && [...label].length <= 100 ? label : id,
      vision: input.includes("image"),
      pdf: input.includes("pdf"),
      reasoning: entry.reasoning === true,
      chat: input.includes("text") && output.includes("text") && !NOT_CHAT_TYPES.has(entry.type),
    };
    const context = entry.limit?.context;
    if (Number.isInteger(context) && context > 0) reduced.contextTokens = context;
    const levels = reduced.reasoning ? levelsOf(api?.[lab]?.models?.[parts.slice(1).join("/")]) : undefined;
    if (levels) reduced.reasoningLevels = levels;
    if (entry.tool_call === true) reduced.tools = true;
    if (input.includes("audio")) reduced.audioIn = true;
    if (input.includes("video")) reduced.videoIn = true;
    if (output.includes("image")) reduced.imageOut = true;
    if (output.includes("video")) reduced.videoOut = true;
    if (output.includes("audio")) reduced.audioOut = true;
    out.push(reduced);
  }
  return out.sort((a, b) => (a.id === b.id ? (a.lab < b.lab ? -1 : a.lab > b.lab ? 1 : 0) : a.id < b.id ? -1 : 1));
}

/** A model of the snapshot by what tells it from every other: its lab and id. */
const keyOf = (e) => `${e.lab}/${e.id}`;
/** The abilities an entry has, as one string (`ABILITIES` order). */
const abilitiesOf = (e) => ABILITIES.filter((a) => e[a] === true).join(",");
const sorted = (list) => list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * What an update changed, by `lab/id`, each list sorted: the models `next` has and `prev` had not, those it lost, and
 * those in both whose abilities (`ABILITIES`) differ. A name, a context, the levels or `chat` are no ability.
 */
export function diffCatalog(prev, next) {
  const was = new Map(prev.map((e) => [keyOf(e), e]));
  const is = new Map(next.map((e) => [keyOf(e), e]));
  return {
    added: sorted([...is.keys()].filter((k) => !was.has(k))),
    removed: sorted([...was.keys()].filter((k) => !is.has(k))),
    changed: sorted([...is.keys()].filter((k) => was.has(k) && abilitiesOf(was.get(k)) !== abilitiesOf(is.get(k)))),
  };
}

/** A summary's line: the count, then at most `SUMMARY_NAMES` names and how many more. */
const named = (title, keys) =>
  `${title} (${keys.length}): ${keys.length === 0 ? "none" : keys.slice(0, SUMMARY_NAMES).join(", ")}${keys.length > SUMMARY_NAMES ? `, and ${keys.length - SUMMARY_NAMES} more` : ""}`;

/** What an update's commit message says below its first line: the counts, what `diffCatalog` found, and how many models have each kept ability. */
export function catalogSummary(prev, next) {
  const diff = diffCatalog(prev, next);
  const count = (a) => next.filter((e) => e[a] === true).length;
  return [
    `Models: ${prev.length} -> ${next.length}`,
    named("Added", diff.added),
    named("Removed", diff.removed),
    named("Abilities changed", diff.changed),
    `With tools: ${count("tools")}; audio in: ${count("audioIn")}; video in: ${count("videoIn")}; image out: ${count("imageOut")}; video out: ${count("videoOut")}; audio out: ${count("audioOut")}`,
  ].join("\n");
}

/**
 * Refuses (throws) a snapshot an upstream outage or a change of the catalogue's format would leave: one with more than
 * `GUARD.maxShrink` fewer entries than `prev`, or one in which more than `GUARD.maxAbleLost` of the models that had an
 * ability in `prev` are gone or have none left; and, ability by ability (`ABILITIES`) — a renamed field upstream takes
 * one ability away while every model keeps another — one that at least `GUARD.minAbilityCount` models had and more than
 * `GUARD.maxAbilityLost` of them no longer have (gone or without it), or one that changed either way on more than
 * `GUARD.maxAbilityFlipped` of the models both snapshots have (a mass gain too). Nothing to compare with (`prev`
 * empty): passes. A deliberate change of that size (a new ability kept) is run by hand, without `--guard`.
 */
export function guardCatalog(prev, next) {
  if (prev.length === 0) return;
  if (next.length < prev.length * (1 - GUARD.maxShrink)) {
    throw new Error(`the snapshot shrank from ${prev.length} to ${next.length} models (more than ${GUARD.maxShrink * 100} %): not written`);
  }
  const is = new Map(next.map((e) => [keyOf(e), e]));
  const able = prev.filter((e) => abilitiesOf(e) !== "");
  const lost = able.filter((e) => !is.has(keyOf(e)) || abilitiesOf(is.get(keyOf(e))) === "").length;
  if (lost > able.length * GUARD.maxAbleLost) {
    throw new Error(`${lost} of the ${able.length} models that had abilities are gone or have none left (more than ${GUARD.maxAbleLost * 100} %): not written`);
  }
  const both = prev.filter((e) => is.has(keyOf(e)));
  for (const ability of ABILITIES) {
    const had = prev.filter((e) => e[ability] === true);
    const kept = had.filter((e) => is.get(keyOf(e))?.[ability] === true).length;
    if (had.length >= GUARD.minAbilityCount && had.length - kept > had.length * GUARD.maxAbilityLost) {
      throw new Error(`${had.length - kept} of the ${had.length} models that had ${ability} no longer have it (more than ${GUARD.maxAbilityLost * 100} %): not written`);
    }
    const flipped = both.filter((e) => (e[ability] === true) !== (is.get(keyOf(e))[ability] === true)).length;
    if (flipped > both.length * GUARD.maxAbilityFlipped) {
      throw new Error(`${ability} changed on ${flipped} of the ${both.length} models both snapshots have (more than ${GUARD.maxAbilityFlipped * 100} %): not written`);
    }
  }
}

/** The same for provider-catalog.json: refuses one with more than `GUARD.maxShrink` fewer providers, or fewer model ids in all, than `prev` (none: passes). */
export function guardProviders(prev, next) {
  if (prev.length === 0) return;
  if (next.length < prev.length * (1 - GUARD.maxShrink)) {
    throw new Error(`the provider list shrank from ${prev.length} to ${next.length} providers (more than ${GUARD.maxShrink * 100} %): not written`);
  }
  const ids = (list) => list.reduce((n, p) => n + (Array.isArray(p.models) ? p.models.length : 0), 0);
  if (ids(next) < ids(prev) * (1 - GUARD.maxShrink)) {
    throw new Error(`the provider list shrank from ${ids(prev)} to ${ids(next)} model ids (more than ${GUARD.maxShrink * 100} %): not written`);
  }
}

/** A plain DNS name as the URL parser leaves it (lower case, punycode): the service's rule for a host (no `${…}` placeholder, no space; a dot; letters, digits, hyphens). */
export const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A model id as a provider's owner could add it: trimmed, 1–100 characters, one line. */
const usableModelId = (id) => id !== "" && !CONTROL.test(id) && [...id].length <= 100;

/**
 * The catalogue's providers by the address they are called at (provider-catalog.json, `catalogueModels` in
 * src/providers/catalogue.ts): for each provider of api.json that names its API address (`api`, an https URL), `{id,
 * hosts, models}` — `hosts` that address's host name (lower case; `doc` is a documentation site, not where the API
 * answers, so it is not kept), `models` its model ids as that provider names them (api.json's keys, trimmed, usable as
 * a model name, each once, sorted). A provider without such an address or any usable id is left out. Sorted by id.
 */
export function reduceProviders(api) {
  if (!isObject(api)) return [];
  const out = [];
  for (const [id, entry] of Object.entries(api)) {
    if (!isObject(entry) || typeof entry.api !== "string" || CONTROL.test(id)) continue;
    let host;
    try {
      const url = new URL(entry.api.trim());
      if (url.protocol !== "https:") continue;
      host = url.hostname.toLowerCase();
    } catch {
      continue;
    }
    const models = [...new Set(Object.keys(isObject(entry.models) ? entry.models : {}).map((m) => m.trim()))].filter(usableModelId).sort();
    if (!DNS_NAME.test(host) || models.length === 0) continue;
    out.push({ id, hosts: [host], models });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The snapshot as written: one entry per line, so that an update reads as a diff of models (or of providers). */
export const formatCatalog = (entries) => `[\n${entries.map((e) => `  ${JSON.stringify(e)}`).join(",\n")}\n]\n`;

const LICENCE = `MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The snapshot's README: where it came from, when, under what licence, how many entries (and providers). */
export function catalogReadme({ fetched, count, providers }) {
  return `# model-catalog.json

A reduced snapshot of the [models.dev](https://models.dev) model catalogue (repository anomalyco/models.dev): what
\`modelHints\` (\`hints.ts\`) knows about a model by its id. Generated by \`npm run catalog:update\`
(\`scripts/update-model-catalog.mjs\`); do not edit it by hand. The service reads it from here and never fetches the
catalogue itself.

- Source: ${MODELS_URL} (the canonical models) and ${API_URL} (each lab's own entry, for its thinking levels; and each provider's API address and model ids, for provider-catalog.json)
- Fetched: ${fetched}
- Licence: MIT (below)
- Entries: ${count}${providers === undefined ? "" : `\n- Providers (provider-catalog.json): ${providers}`}

Each entry: \`id\` (the model id, lower case), \`lab\`, \`name\` (its display name), \`vision\` (takes images), \`pdf\` (takes
PDFs), \`reasoning\`, \`chat\` (takes and answers text, and is not an embedding, reranking, speech, transcription, image,
video or realtime model), \`contextTokens\` (when the catalogue gives one), \`reasoningLevels\` (the lab's \`effort\`
values among \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`, when it has them), and six abilities that are there only as
\`true\` (absent: no, or the catalogue does not say): \`tools\` (the catalogue's \`tool_call\`), \`audioIn\` and \`videoIn\`
(takes audio, video), \`imageOut\`, \`videoOut\` and \`audioOut\` (answers with images, video, audio).

An ability is answered only for the model itself (its id, or the id without a \`-latest\` or date suffix), never for a
name that merely starts with an id. This catalogue's \`tools\` reaches a client as \`reportedTools\`, beside the \`tools\` a
saved provider model stores (its owner's choice, a reply that failed for lack of tools, a reply whose tool call ran);
the two are never merged by the service. Whoever draws the mark reads them in this order: stored \`false\` > stored
\`true\` > \`reportedTools\` > unknown (app/service/README.md, "Model providers").

## Daily update

\`.github/workflows/catalog-update.yml\` runs the script once a day (and by hand: Actions > "Model catalogue update" >
Run workflow, once its trigger is on the default branch: docs/dev/ci.md) with \`--guard\`: nothing is written when,
against the previous snapshot, the new one shrank by more than ${GUARD.maxShrink * 100} %, lost more than ${GUARD.maxAbleLost * 100} % of the ids that had abilities, lost
more than ${GUARD.maxAbilityLost * 100} % of one ability, changed one ability on more than ${GUARD.maxAbilityFlipped * 100} % of the models both have, or the provider list lost
more than ${GUARD.maxShrink * 100} % of its providers or model ids. A changed snapshot is committed to the development branch only
after the service type check and the tests that read it pass; the commit message says what was added, removed and
changed.

# provider-catalog.json

From the same api.json: the catalogue's providers that name their API address, what \`catalogueModels\`
(\`catalogue.ts\`) offers a provider whose address has no model list (\`POST /api/providers/:id/models/list\`). Each entry:
\`id\` (the catalogue's provider id), \`hosts\` (the host name of its \`api\` address, lower case) and \`models\` (its model ids
as it names them, sorted).

## Licence of the catalogue data

${LICENCE}`;
}

async function downloadOnce(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { accept: "application/json" } });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOWNLOAD_BYTES) throw new Error(`${url}: larger than expected`);
  return text;
}

/** One download, tried `DOWNLOAD.tries` times in all (a network error, a status other than 200): the last failure is thrown. */
async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(url);
    } catch (err) {
      if (attempt >= DOWNLOAD.tries) throw err;
      console.error(`${err instanceof Error ? err.message : err}; trying again (${attempt + 1}/${DOWNLOAD.tries})`);
      await new Promise((done) => setTimeout(done, DOWNLOAD.waitMs));
    }
  }
}

/** The snapshot on disk as a list; none (empty) when there is no file yet. */
function previousCatalog(file) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed.filter(isObject) : [];
}

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const unknown = flags.filter((f) => f !== "--guard" && !/^--summary=.+/.test(f));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown[0]} (--guard, --summary=<file>)`);
  const guard = flags.includes("--guard");
  const summaryFile = flags.find((f) => f.startsWith("--summary="))?.slice("--summary=".length);
  const [modelsFile, apiFile] = args.filter((a) => !a.startsWith("--"));
  if (Boolean(modelsFile) !== Boolean(apiFile)) throw new Error("give both saved files (models.json and api.json), or neither");
  const models = JSON.parse(modelsFile ? readFileSync(modelsFile, "utf8") : await download(MODELS_URL));
  const api = JSON.parse(apiFile ? readFileSync(apiFile, "utf8") : await download(API_URL));
  const entries = reduceCatalog(models, api);
  if (entries.length < 100) throw new Error(`only ${entries.length} models: not writing a snapshot that small`);
  const providers = reduceProviders(api);
  if (providers.length < 20) throw new Error(`only ${providers.length} providers with an API address: not writing a snapshot that small`);
  const fetched = (modelsFile ? statSync(modelsFile).mtime : new Date()).toISOString().slice(0, 10);
  const dir = new URL("../src/providers/", import.meta.url);
  const previous = previousCatalog(new URL("model-catalog.json", dir));
  const previousProviders = previousCatalog(new URL("provider-catalog.json", dir));
  if (guard) {
    guardCatalog(previous, entries);
    guardProviders(previousProviders, providers);
  }
  const providersBefore = previousProviders.length;
  const summary = `${catalogSummary(previous, entries)}\nProviders (provider-catalog.json): ${providersBefore} -> ${providers.length}`;
  if (summaryFile) writeFileSync(summaryFile, `${summary}\n`);
  writeFileSync(new URL("model-catalog.json", dir), formatCatalog(entries));
  writeFileSync(new URL("provider-catalog.json", dir), formatCatalog(providers));
  writeFileSync(new URL("model-catalog.README.md", dir), catalogReadme({ fetched, count: entries.length, providers: providers.length }));
  console.log(`model-catalog.json: ${entries.length} models (${entries.filter((e) => e.reasoningLevels).length} with their thinking levels), fetched ${fetched}`);
  console.log(`provider-catalog.json: ${providers.length} providers, ${providers.reduce((n, p) => n + p.models.length, 0)} model ids`);
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
