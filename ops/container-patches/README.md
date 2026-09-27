# Container hot patches

Runtime patches applied to the **worker** container of our self-hosted
OpenPanel (`lindesvard/openpanel-worker:2.3.0`). Each one rewrites the compiled
bundle at `/app/apps/worker/dist/index.js` in place.

> **These live in the container's writable layer.** They survive
> `docker restart`. They do **not** survive a Dokploy redeploy, a
> `docker compose pull`, or anything that recreates the container — and our
> compose pins the moving tag `:2`, so a pull can silently move us off 2.3.0.
> **After any redeploy, re-apply everything in this directory.**

The real fixes are upstream PRs (linked in each file). Once a release contains
them, delete the corresponding patch here.

## Production

| | |
|---|---|
| Host | `gc-dev-01` (Dokploy) — `docker` needs `sudo` |
| Worker | `26fa452088bc` — `toolbox-openpanel-sdzpjl-op-worker-1` |
| ClickHouse | `9ce9159eb5c4` — `toolbox-openpanel-sdzpjl-op-ch-1` |
| Postgres | `541b73e44b92` — `toolbox-openpanel-sdzpjl-op-db-1` |
| Redis | `8326f70e13f5` — `toolbox-openpanel-sdzpjl-op-kv-1` |

Container ids change on redeploy. Re-resolve with:

```bash
sudo docker ps --format '{{.ID}}  {{.Names}}  {{.Image}}' | grep open
```

## Apply all (in order)

Order matters: `02` refuses to run unless `01` is present, and `03` refuses
unless `02` is.

```bash
WORKER=26fa452088bc

for p in patch-mixpanel-engage.cjs patch-mixpanel-dates.cjs \
         patch-mixpanel-offset.cjs patch-clickhouse-timeout.cjs; do
  sudo docker cp "ops/container-patches/$p" "$WORKER:/tmp/$p"
done

sudo docker exec $WORKER node /tmp/patch-mixpanel-engage.cjs
sudo docker exec $WORKER node /tmp/patch-mixpanel-dates.cjs
sudo docker exec $WORKER node /tmp/patch-mixpanel-offset.cjs 0
sudo docker exec $WORKER node /tmp/patch-clickhouse-timeout.cjs 3600000

sudo docker exec $WORKER node --check /app/apps/worker/dist/index.js && echo PARSES_OK
sudo docker restart $WORKER
```

Every patcher is **idempotent** and **aborts** unless its anchor text matches
exactly once, so re-running is safe and a bundle it doesn't recognise is
refused rather than mangled.

## Verify

```bash
WORKER=26fa452088bc
sudo docker exec $WORKER sh -c '
  echo -n "engage:  "; grep -c "body.set(\"session_id\", sessionId)" /app/apps/worker/dist/index.js
  echo -n "dates:   "; grep -c "parseMpDate\$op"                     /app/apps/worker/dist/index.js
  echo -n "offset:  "; grep -o "props.time \* 1e3 - [0-9.]* \* 36e5" /app/apps/worker/dist/index.js
  echo -n "timeout: "; grep -o "CLICKHOUSE_REQUEST_TIMEOUT_MS, 10)) : [0-9e]*" /app/apps/worker/dist/index.js
'
```

Expected:

```
engage:  1
dates:   3
offset:  props.time * 1e3 - 0 * 36e5
timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS, 10)) : 3600000
```

The worker also logs its effective timeout on boot:

```bash
sudo docker logs --since 2m $WORKER 2>&1 | grep -o 'requestTimeoutMs":[0-9]*'
```

## The patches

| # | File | Fixes | Upstream |
|---|---|---|---|
| 01 | [`01-mixpanel-engage-session-id.md`](./01-mixpanel-engage-session-id.md) | Mixpanel profile import fails with `must have session_id when requesting page > 0` | `fix/mixpanel-engage-session-id` |
| 02 | [`02-mixpanel-profile-dates.md`](./02-mixpanel-profile-dates.md) | Every imported profile stamped with the import's wall clock | `fix/mixpanel-profile-dates` |
| 03 | [`03-mixpanel-project-timezone.md`](./03-mixpanel-project-timezone.md) | Mixpanel event times read as UTC when they are project-local | `feat/mixpanel-import-timezone` |
| 04 | [`04-clickhouse-request-timeout.md`](./04-clickhouse-request-timeout.md) | Large imports fail with `Timeout error.` mid-pipeline | — (no PR yet) |

## Rollback

Each patcher writes a backup next to the bundle before changing it:

| Patch | Backup |
|---|---|
| 01 | `index.js.orig` |
| 02 | `index.js.pre-dates` |
| 03 | `index.js.pre-offset` |
| 04 | `index.js.pre-timeout` |

`index.js.orig` is the pristine 2.3.0 bundle
(`sha256 171845caca48a3f772fa240e9deace25b9f64398cd30ee4bda811936065d289a`).
To revert everything:

```bash
sudo docker exec $WORKER cp /app/apps/worker/dist/index.js.orig /app/apps/worker/dist/index.js
sudo docker restart $WORKER
```
