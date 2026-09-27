# 01 — Mixpanel Engage `session_id` pagination

**Script:** `patch-mixpanel-engage.cjs`
**Upstream:** `fix/mixpanel-engage-session-id`
**Applied to production:** 2026-09-24

## Symptom

Mixpanel imports fail partway through, after all events have already been
staged:

```
Failed to fetch profiles from Mixpanel: 400 Bad Request -
{"request":"/api/query/engage?project_id=3046375",
 "error":"must have session_id when requesting page > 0"}
```

## Cause

Mixpanel's `/api/query/engage` is **session paginated**: page 0 opens a
snapshot and returns a `session_id`, and every later page must replay it.
`streamProfiles` only sent `page` and `page_size`, so page 1 was always
rejected.

Any project with more than one page of profiles (>5,000) hits this.

## Why it hurts more than it looks

The failure lands in the `loading_profiles` step, which is **not** in
`RESUMABLE_STEPS` (`apps/worker/src/jobs/import.ts`). A retry therefore calls
`cleanupStagingData()` and re-exports every event from Mixpanel before failing
at the same place. On our 5.4M-event import that was ~15 wasted minutes per
attempt; on the 56M one it would have been hours.

## What the patch changes

`MixpanelProvider.streamProfiles` in the bundle:

1. captures `session_id` from each response and sends it on later pages
2. paginates on the `page_size` Mixpanel reports, not the one requested — it
   may return a smaller page, which previously truncated the import silently
   after one page
3. stops instead of spending a request on a page certain to 400

## Apply

```bash
sudo docker cp ops/container-patches/patch-mixpanel-engage.cjs 26fa452088bc:/tmp/
sudo docker exec 26fa452088bc node /tmp/patch-mixpanel-engage.cjs
sudo docker exec 26fa452088bc node --check /app/apps/worker/dist/index.js && echo PARSES_OK
sudo docker restart 26fa452088bc
```

Expect four `[patch] ok:` lines. `[patch] ABORT` means the bundle isn't the one
this was written against — stop and re-check the image tag.

## Verify

```bash
sudo docker exec 26fa452088bc grep -c 'body.set("session_id", sessionId)' \
  /app/apps/worker/dist/index.js     # -> 1
```

During an import, the profile phase should advance past page 0:

```bash
sudo docker logs -f 26fa452088bc 2>&1 | grep "Mixpanel Engage"
```

`page: 1`, `page: 2`, … means it works. Our verification run imported
**259,350 profiles across ~52 pages**, where the unpatched code stopped at
5,000.

## Rollback

```bash
sudo docker exec 26fa452088bc cp /app/apps/worker/dist/index.js.orig \
  /app/apps/worker/dist/index.js
sudo docker restart 26fa452088bc
```
