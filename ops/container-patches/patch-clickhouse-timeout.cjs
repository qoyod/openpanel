#!/usr/bin/env node
/**
 * Raise the ClickHouse client request timeout baked into a worker bundle.
 *
 * The default is 30s, which is fine for normal inserts but far too short for the
 * import pipeline's bulk steps once a project has tens of millions of staged
 * rows: the session-ID, session-creation and staging->production steps each run
 * for many minutes. When the client gives up, the job is marked failed even
 * though ClickHouse finishes the work server-side.
 *
 * Normally this is set via CLICKHOUSE_REQUEST_TIMEOUT_MS, but applying an env
 * change means recreating the container, which discards the other hot patches.
 * This rewrites the compiled default instead.
 *
 * Usage (inside the worker container):
 *   node /tmp/patch-clickhouse-timeout.cjs <ms> [file]
 *   e.g. node /tmp/patch-clickhouse-timeout.cjs 3600000
 *
 * Aborts unless exactly one default is present. Idempotent.
 */
const fs = require('node:fs');

const ms = Number(process.argv[2]);
const target = process.argv[3] || '/app/apps/worker/dist/index.js';

if (!Number.isFinite(ms) || ms < 1000) {
  console.error('[timeout] usage: node patch-clickhouse-timeout.cjs <ms>=1000> [file]');
  process.exit(1);
}

if (!fs.existsSync(target)) {
  console.error(`[timeout] not found: ${target}`);
  process.exit(1);
}

const PREFIX =
  'CLICKHOUSE_REQUEST_TIMEOUT_MS ? Math.max(1e3, Number.parseInt(process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS, 10)) : ';
const RE = new RegExp(
  `${PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\d+(?:\\.\\d+)?(?:e\\d+)?)`,
  'gu'
);

let source = fs.readFileSync(target, 'utf8');
const matches = [...source.matchAll(RE)];

if (matches.length !== 1) {
  console.error(
    `[timeout] ABORT: expected exactly 1 timeout default, found ${matches.length}.`
  );
  process.exit(1);
}

const current = Number(matches[0][1]);
if (current === ms) {
  console.log(`[timeout] already ${ms}ms — nothing to do`);
  process.exit(0);
}

source = source.replace(RE, `${PREFIX}${ms}`);
fs.copyFileSync(target, `${target}.pre-timeout`);
fs.writeFileSync(target, source);
console.log(`[timeout] changed ${current}ms -> ${ms}ms`);
console.log(`[timeout] wrote ${target} (backup at ${target}.pre-timeout)`);
