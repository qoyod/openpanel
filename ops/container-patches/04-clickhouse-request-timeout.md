# 04 — ClickHouse client request timeout

**Script:** `patch-clickhouse-timeout.cjs`
**Current production value:** `3600000` ms (1 hour)
**Upstream:** none yet — see "Real fix" below
**Applied to production:** 2026-09-25

## Symptom

A large import fails mid-pipeline with no useful message:

```
"failedReason":"Timeout error."
at Socket.onTimeout (@clickhouse/client/dist/connection/socket_pool.js)
currentStep: generating_sessions
```

## Cause

`packages/db/src/clickhouse/client.ts` defaults `request_timeout` to **30s**.
That's fine for ordinary inserts, and deliberately short so a stuck insert
fails over to another node quickly.

It is far too short for the import pipeline's bulk steps once a project has
tens of millions of staged rows. On our 56M-event import, `generating_sessions`
ran ~14 minutes and held ~19.8 GiB server-side before the client gave up.

## The nasty part

**ClickHouse keeps running after the client disconnects.** In our case the work
actually completed — the trailing `ALTER TABLE … DELETE` (issued with
`mutations_sync: '2'`) finished server-side about 14 minutes later — but the
job had already been marked `failed`. The data was correct and the import
said otherwise.

That matters when recovering: check the data before assuming a step must be
redone. We confirmed completion with

```sql
SELECT countIf(session_id = '' AND device != 'server') AS eligible_remaining,
       count() AS total, uniqExact(id) AS distinct_ids
FROM events_imports WHERE project_id = '<project>';
```

`eligible_remaining = 0` and `distinct_ids = total` meant the step was done,
and we resumed rather than re-downloading 56M events.

## What the patch changes

Rewrites the compiled default from `3e4` to the given value. The env var
`CLICKHOUSE_REQUEST_TIMEOUT_MS` still takes precedence when set — we patch the
default instead of setting the env var because applying an env change means
recreating the container, which discards every other patch here.

## Apply

```bash
sudo docker cp ops/container-patches/patch-clickhouse-timeout.cjs 26fa452088bc:/tmp/
sudo docker exec 26fa452088bc node /tmp/patch-clickhouse-timeout.cjs 3600000
sudo docker exec 26fa452088bc node --check /app/apps/worker/dist/index.js && echo PARSES_OK
sudo docker restart 26fa452088bc
```

## Verify

The worker logs its effective timeout on boot:

```bash
sudo docker logs --since 2m 26fa452088bc 2>&1 | grep -o 'requestTimeoutMs":[0-9]*'
# -> requestTimeoutMs":3600000
```

## Real fix

Raising the timeout treats the symptom. The underlying problem is that
`generateGapBasedSessionIds` streams **every** staged row out to Node, assigns
session ids in JS, and writes them all back — a 56M-row round trip. It should
be a ClickHouse window function over `device_id ORDER BY created_at`, which
needs no client round trip and no long-held HTTP request.

Related: the importer never cleans `events_imports` after a **successful**
import, so staging grows unbounded across runs.

Both are queued as upstream PRs.

## Rollback

```bash
sudo docker exec 26fa452088bc cp /app/apps/worker/dist/index.js.pre-timeout \
  /app/apps/worker/dist/index.js
sudo docker restart 26fa452088bc
```
