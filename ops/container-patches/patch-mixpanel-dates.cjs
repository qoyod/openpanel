#!/usr/bin/env node
/**
 * Hot-patch #2 for openpanel-worker 2.3.0: Mixpanel date handling.
 *
 * Apply AFTER patch-mixpanel-engage.cjs (it expects that patch already in place).
 *
 *  1. transformEvent: Mixpanel's /api/2.0/export returns properties.time as a unix
 *     epoch in PROJECT time, not UTC. Reading it as UTC shifts every event by the
 *     project's offset. Asia/Riyadh is UTC+3 year round (no DST), so subtract 3h.
 *     Hardcoded deliberately -- the upstream fix adds a timezone field to the
 *     import config instead.
 *
 *  2. transformProfile: $created/$last_seen are used properly, and the fallback is
 *     the import window start rather than Date.now(). "Now" both invents a date and
 *     hands the row the highest possible ReplacingMergeTree(last_seen_at) version,
 *     so a corrected re-import would silently lose to it.
 *
 *  3. transformProfile: last_seen_at was a copy of created_at, so first-seen always
 *     equalled last-seen.
 *
 * Usage (inside the worker container):
 *   node /tmp/patch-mixpanel-dates.cjs /app/apps/worker/dist/index.js
 *
 * Idempotent: re-running on an already-patched file exits 0 and changes nothing.
 */
const fs = require('node:fs');

const target = process.argv[2] || '/app/apps/worker/dist/index.js';

/** Asia/Riyadh, no DST. */
const PROJECT_UTC_OFFSET_HOURS = 3;

const edits = [
  {
    name: 'transformEvent: read Mixpanel time as project-local, not UTC',
    from:
      '\t\t\tcreated_at: formatClickhouseDate(/* @__PURE__ */ new Date(props.time * 1e3)),\n',
    to:
      `\t\t\tcreated_at: formatClickhouseDate(new Date(props.time * 1e3 - ${PROJECT_UTC_OFFSET_HOURS} * 36e5)),\n`,
  },
  {
    name: 'transformProfile: date from $created/$last_seen, never Date.now()',
    from:
      '\t\tconst createdAt = props.$created ? formatClickhouseDate(new Date(String(props.$created))) : formatClickhouseDate(/* @__PURE__ */ new Date());\n',
    to:
      '\t\tconst parseMpDate$op = (v) => {\n' +
      '\t\t\tif (v == null || v === "") return void 0;\n' +
      '\t\t\tconst raw = String(v).trim();\n' +
      '\t\t\tconst norm = /^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?$/.test(raw) ? raw.replace(" ", "T") + "Z" : raw;\n' +
      '\t\t\tconst d = new Date(norm);\n' +
      '\t\t\treturn Number.isNaN(d.getTime()) ? void 0 : d;\n' +
      '\t\t};\n' +
      '\t\tconst created$op = parseMpDate$op(props.$created);\n' +
      '\t\tconst lastSeen$op = parseMpDate$op(props.$last_seen);\n' +
      '\t\tconst fallback$op = new Date(this.config.from);\n' +
      '\t\tconst createdAt = formatClickhouseDate(created$op ?? lastSeen$op ?? fallback$op);\n' +
      '\t\tconst lastSeenAt$op = formatClickhouseDate(lastSeen$op ?? created$op ?? fallback$op);\n',
  },
  {
    name: 'transformProfile: last_seen_at is real activity, not a copy',
    from: '\t\t\tlast_seen_at: createdAt,\n',
    to: '\t\t\tlast_seen_at: lastSeenAt$op,\n',
  },
];

if (!fs.existsSync(target)) {
  console.error(`[patch2] not found: ${target}`);
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');

if (!source.includes('body.set("session_id", sessionId)')) {
  console.error('[patch2] ABORT: patch-mixpanel-engage.cjs has not been applied.');
  process.exit(1);
}

if (source.includes('parseMpDate$op')) {
  console.log('[patch2] already applied — nothing to do');
  process.exit(0);
}

for (const edit of edits) {
  const hits = source.split(edit.from).length - 1;
  if (hits !== 1) {
    console.error(
      `[patch2] ABORT: expected exactly 1 match for "${edit.name}", found ${hits}.`
    );
    process.exit(1);
  }
  source = source.replace(edit.from, edit.to);
  console.log(`[patch2] ok: ${edit.name}`);
}

fs.copyFileSync(target, `${target}.pre-dates`);
fs.writeFileSync(target, source);
console.log(`[patch2] wrote ${target} (backup at ${target}.pre-dates)`);
