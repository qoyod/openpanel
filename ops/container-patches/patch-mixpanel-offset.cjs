#!/usr/bin/env node
/**
 * Adjust the hardcoded Mixpanel project-time offset in a patched worker bundle.
 *
 * patch-mixpanel-dates.cjs bakes in `- N * 36e5` on the event timestamp. When the
 * Mixpanel project's timezone changes, that constant has to change with it.
 *
 * Usage (inside the worker container):
 *   node /tmp/patch-mixpanel-offset.cjs <hours> [file]
 *
 * e.g. `node /tmp/patch-mixpanel-offset.cjs 0`  -> project is on UTC, no shift
 *      `node /tmp/patch-mixpanel-offset.cjs 3`  -> project is on Asia/Riyadh
 *
 * Aborts unless exactly one offset expression is present. Idempotent.
 */
const fs = require('node:fs');

const hours = Number(process.argv[2]);
const target = process.argv[3] || '/app/apps/worker/dist/index.js';

if (!Number.isFinite(hours)) {
  console.error('[offset] usage: node patch-mixpanel-offset.cjs <hours> [file]');
  process.exit(1);
}

if (!fs.existsSync(target)) {
  console.error(`[offset] not found: ${target}`);
  process.exit(1);
}

const OFFSET_RE = /props\.time \* 1e3 - (-?[\d.]+) \* 36e5/gu;

let source = fs.readFileSync(target, 'utf8');
const matches = [...source.matchAll(OFFSET_RE)];

if (matches.length !== 1) {
  console.error(
    `[offset] ABORT: expected exactly 1 offset expression, found ${matches.length}.`
  );
  console.error('[offset] Is patch-mixpanel-dates.cjs applied to this bundle?');
  process.exit(1);
}

const current = Number(matches[0][1]);
if (current === hours) {
  console.log(`[offset] already ${hours}h — nothing to do`);
  process.exit(0);
}

source = source.replace(OFFSET_RE, `props.time * 1e3 - ${hours} * 36e5`);
fs.copyFileSync(target, `${target}.pre-offset`);
fs.writeFileSync(target, source);
console.log(`[offset] changed ${current}h -> ${hours}h`);
console.log(`[offset] wrote ${target} (backup at ${target}.pre-offset)`);
