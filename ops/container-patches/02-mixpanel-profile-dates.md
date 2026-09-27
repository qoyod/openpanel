# 02 — Mixpanel profile dates

**Script:** `patch-mixpanel-dates.cjs`
**Upstream:** `fix/mixpanel-profile-dates`
**Applied to production:** 2026-09-24
**Requires:** patch 01 (the script refuses to run without it)

## Symptom

Every imported profile shows the same "first seen" and "last seen", both equal
to the moment the import ran — not to anything the user actually did.

## Cause

Three defects in `transformProfile`:

1. `last_seen_at` was a copy of `created_at`, so first-seen always equalled
   last-seen. Mixpanel's `$last_seen` was never read.
2. When `$created` was absent the fallback was `new Date()`, stamping every
   profile with the import's wall clock.
3. `$created` was parsed with `new Date()` on a naive timestamp, which
   ECMAScript reads as **local** time — so stored dates depended on the
   container's `TZ`.

## Why (2) is worse than a wrong date

`profiles` is `ReplacingMergeTree(last_seen_at)`. An import-time value is the
**highest version possible**, so a later corrected import writes earlier, real
timestamps and silently **loses** the dedup — the bad rows keep winning.
Repairing affected data means deleting the bad rows first; re-importing alone
does nothing.

## What the patch changes

- reads `$created` and `$last_seen`, falling back to each other and then to the
  import window start — never `Date.now()`
- pins naive timestamps to UTC so an import is reproducible wherever it runs
- `last_seen_at` becomes real activity rather than a copy

## Known gap

Our Mixpanel project does **not** return `$created`, only `$last_seen`. With
the fallback chain that means `created_at` ends up equal to `$last_seen` —
real, but semantically "last seen" rather than "created". `last_seen_at`
itself is correct.

Verified on production data: 90.1% of profiles have their stored date at or
after their last event and only 1.0% at or before their first, which is the
signature of `$last_seen`.

The upstream branch should be reworked to derive `created_at` from the
profile's earliest imported event when `$created` is missing. Until then,
treat profile "first seen" as approximate.

## Apply

```bash
sudo docker cp ops/container-patches/patch-mixpanel-dates.cjs 26fa452088bc:/tmp/
sudo docker exec 26fa452088bc node /tmp/patch-mixpanel-dates.cjs
sudo docker exec 26fa452088bc node --check /app/apps/worker/dist/index.js && echo PARSES_OK
sudo docker restart 26fa452088bc
```

Expect three `[patch2] ok:` lines.

> The script also contains the **−Nh project-timezone shift** used by patch 03.
> It applies it at `0h` by default via `PROJECT_UTC_OFFSET_HOURS`; patch 03 is
> what sets the live value. Apply 03 after this one.

## Verify

```bash
sudo docker exec 26fa452088bc grep -c 'parseMpDate\$op' \
  /app/apps/worker/dist/index.js     # -> 3
```

After an import, profile dates should span real history and not cluster on the
import timestamp:

```bash
sudo docker exec 9ce9159eb5c4 clickhouse-client -d openpanel --query \
"SELECT min(created_at), max(last_seen_at), count() FROM profiles FINAL
 WHERE project_id='<project>'"
```

## Rollback

```bash
sudo docker exec 26fa452088bc cp /app/apps/worker/dist/index.js.pre-dates \
  /app/apps/worker/dist/index.js
sudo docker restart 26fa452088bc
```
