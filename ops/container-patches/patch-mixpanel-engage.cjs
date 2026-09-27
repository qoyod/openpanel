#!/usr/bin/env node
/**
 * Hot-patch for openpanel-worker 2.3.0: Mixpanel Engage profile pagination.
 *
 * Mixpanel's /api/query/engage is session-paginated. Page 0 opens a snapshot and
 * returns its session_id; every later page must replay that id or Mixpanel answers
 * 400 "must have session_id when requesting page > 0". The bundled streamProfiles
 * only sends page/page_size, so any project with more than one page of profiles
 * fails the import right after all events have been staged.
 *
 * Usage (inside the worker container):
 *   node /tmp/patch-mixpanel-engage.cjs /app/apps/worker/dist/index.js
 *
 * Idempotent: re-running on an already-patched file exits 0 and changes nothing.
 */
const fs = require('node:fs');

const target = process.argv[2] || '/app/apps/worker/dist/index.js';

const edits = [
  {
    name: 'declare sessionId / make pageSize reassignable',
    from: '\t\tconst pageSize = 5e3;\n\t\tlet page = 0;\n',
    to: '\t\tconst requestedPageSize = 5e3;\n\t\tlet pageSize = requestedPageSize;\n\t\tlet sessionId = void 0;\n\t\tlet page = 0;\n',
  },
  {
    name: 'send session_id on pages after the first',
    from:
      '\t\t\tconst body = new URLSearchParams({\n' +
      '\t\t\t\tpage: String(page),\n' +
      '\t\t\t\tpage_size: String(pageSize)\n' +
      '\t\t\t});\n',
    to:
      '\t\t\tconst body = new URLSearchParams({\n' +
      '\t\t\t\tpage: String(page),\n' +
      '\t\t\t\tpage_size: String(requestedPageSize)\n' +
      '\t\t\t});\n' +
      '\t\t\tif (sessionId) body.set("session_id", sessionId);\n',
  },
  {
    name: 'capture session_id and the page_size Mixpanel actually used',
    from: '\t\t\tconst results = (await response$2.json()).results ?? [];\n',
    to:
      '\t\t\tconst payload$op = await response$2.json();\n' +
      '\t\t\tsessionId = payload$op.session_id ?? sessionId;\n' +
      '\t\t\tpageSize = payload$op.page_size ?? pageSize;\n' +
      '\t\t\tconst results = payload$op.results ?? [];\n',
  },
  {
    name: 'stop instead of requesting a page that is certain to 400',
    from: '\t\t\tif (results.length < pageSize) break;\n',
    to: '\t\t\tif (results.length < pageSize || !sessionId) break;\n',
  },
];

if (!fs.existsSync(target)) {
  console.error(`[patch] not found: ${target}`);
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');

if (source.includes('body.set("session_id", sessionId)')) {
  console.log('[patch] already applied — nothing to do');
  process.exit(0);
}

for (const edit of edits) {
  const hits = source.split(edit.from).length - 1;
  if (hits !== 1) {
    console.error(
      `[patch] ABORT: expected exactly 1 match for "${edit.name}", found ${hits}.`
    );
    console.error('[patch] This bundle is not the one this patch was written for.');
    process.exit(1);
  }
  source = source.replace(edit.from, edit.to);
  console.log(`[patch] ok: ${edit.name}`);
}

fs.copyFileSync(target, `${target}.orig`);
fs.writeFileSync(target, source);
console.log(`[patch] wrote ${target} (backup at ${target}.orig)`);
