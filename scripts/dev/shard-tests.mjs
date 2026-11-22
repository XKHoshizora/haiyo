// Development tool: run a checkout's service tests split over several test databases at once.
// Run FROM the checkout's app/service folder:  node <this file> [-n 3] [vitest args / test files...]
// Each shard i runs `npx vitest run --shard=i/n <args>` against database "<that checkout's test db>_s<i>" (created if absent).
// --tag <letters> picks another set of databases ("<db>_<tag><i>", default tag "s") — use a new tag for a FRESH set
// (nothing is ever dropped). At most 2 sharded runs happen at once on one machine; further runs wait for a slot.
// Reads ./.env itself and prints nothing from it. Output of each shard goes to ./.shard-<i>.log; a summary is printed.
import { readFileSync, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
const args = process.argv.slice(2);
let n = 3, tag = "s";
for (;;) {
  if (args[0] === "-n") { n = Number(args[1]); args.splice(0, 2); }
  else if (args[0] === "--tag") { tag = String(args[1] ?? ""); args.splice(0, 2); }
  else break;
}
if (!/^[a-z]{1,4}$/.test(tag)) { console.error("--tag takes 1-4 lowercase letters"); process.exit(2); }
if (!(n >= 2 && n <= 4)) { console.error("usage: shard-tests.mjs [-n 2..4] [vitest args]"); process.exit(2); }
const cwd = process.cwd();
const require = createRequire(path.join(cwd, "package.json"));
const line = readFileSync(path.join(cwd, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("TEST_DATABASE_URL="));
if (!line) { console.error("TEST_DATABASE_URL not found in ./.env (run from app/service)"); process.exit(2); }
const base = new URL(line.slice("TEST_DATABASE_URL=".length).trim().replace(/^["']|["']$/g, ""));
const baseName = decodeURIComponent(base.pathname.replace(/^\/+/, ""));
const { Client } = require("pg");
const admin = new URL(base); admin.pathname = "/postgres";
const c = new Client({ connectionString: admin.toString() });
await c.connect();
const urls = [];
for (let i = 1; i <= n; i++) {
  const name = `${baseName}_${tag}${i}`;
  const has = await c.query("select 1 from pg_database where datname = $1", [name]);
  if (has.rowCount === 0) await c.query(`create database "${name.replace(/"/g, '""')}"`);
  const u = new URL(base); u.pathname = "/" + encodeURIComponent(name); urls.push(u.toString());
}
await c.end();
// One machine, many lanes: at most MAX_RUNS sharded runs at a time; the others wait their turn here.
import { mkdirSync, rmdirSync, statSync } from "node:fs";
const SLOTS = "C:/Users/hoshi/AppData/Local/Temp/claude/5ad5fe45d4b9222f/b5735b45-c8de-49ce-8ccf-3a594f06419a/scratchpad/test-slots", MAX_RUNS = 2;
mkdirSync(SLOTS, { recursive: true });
let slot = null; const waitFrom = Date.now();
while (!slot) {
  for (let k = 1; k <= MAX_RUNS && !slot; k++) {
    const d = `${SLOTS}/slot-${k}`;
    try { mkdirSync(d); slot = d; } catch { try { if (Date.now() - statSync(d).mtimeMs > 3 * 3600_000) rmdirSync(d); } catch {} }
  }
  if (!slot) await new Promise((r) => setTimeout(r, 5000));
}
const release = () => { try { rmdirSync(slot); } catch {} };
process.on("exit", release); for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { release(); process.exit(130); });
if (Date.now() - waitFrom > 6000) console.log(`(waited ${Math.round((Date.now() - waitFrom) / 1000)} s for a test slot)`);
const started = Date.now();
const results = await Promise.all(urls.map((url, k) => new Promise((resolve) => {
  const i = k + 1, log = createWriteStream(path.join(cwd, `.shard-${i}.log`));
  const p = spawn(`npx vitest run --shard=${i}/${n} ${args.join(" ")}`, { cwd, shell: true, env: { ...process.env, TEST_DATABASE_URL: url } });
  let tail = "";
  const on = (d) => { log.write(d); tail = (tail + d).slice(-4000); };
  p.stdout.on("data", on); p.stderr.on("data", on);
  p.on("close", (code) => { log.end(); resolve({ i, code, tail }); });
})));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
for (const r of results) {
  const t = strip(r.tail).split(/\r?\n/).filter((l) => /Test Files|Tests |FAIL|failed/.test(l)).slice(-6).join("\n  ");
  console.log(`shard ${r.i}/${n}: exit ${r.code}\n  ${t}`);
}
console.log(`wall time ${Math.round((Date.now() - started) / 1000)} s; full logs: .shard-<i>.log`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
