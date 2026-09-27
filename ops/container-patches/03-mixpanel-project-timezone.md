# 03 — Mixpanel project-timezone offset

**Script:** `patch-mixpanel-offset.cjs`
**Upstream:** `feat/mixpanel-import-timezone`
**Current production value:** `0` hours
**Requires:** patch 02

## Background

Mixpanel's `/api/2.0/export` returns `properties.time` as a unix epoch in the
**project's timezone**, not UTC. `transformEvent` read it as UTC, so every
imported event landed shifted by the project's offset.

Evidence from the repo's own test fixtures, which carry both `time` and
`$mp_api_timestamp_ms` (the true UTC receipt time):

| `time` read as UTC | true UTC receipt | skew |
|---|---|---|
| 2025-05-01 11:12:50 | 2025-05-01 05:42:55 | 5.4985 h |
| 2025-10-08 18:16:07 | 2025-10-08 12:46:10 | 5.4990 h |

Both ≈ +05:30 — that project's timezone.

## Why ours is currently `0`

Our Mixpanel project **was** `Asia/Riyadh` (UTC+3) and we ran at `3`. On
2026-09-24 the project timezone was changed to **UTC**, and we confirmed
empirically that the export honours the change retroactively:

```
time: 2026-09-23T00:20:50 | receipt: 2026-09-23T00:20:50.946 | skew: -0.000 h
time: 2026-09-23T01:22:50 | receipt: 2026-09-23T01:22:50.863 | skew: -0.000 h
... 8/8 events, skew 0.000
```

So while the project stays on UTC, the correct value is `0`.

> Mixpanel's docs say a timezone change is "not retroactive". That refers to
> **ingestion**, not export — the export API converts at query time using the
> project's *current* timezone. Measure, don't assume.

## How to decide the value

Don't infer it from the min/max of imported events: with the project on UTC a
correct import spans `00:00:0x → 23:59:5x`, which is the exact signature that
previously meant "shifted". Measure the skew directly instead:

```bash
curl -s -u "SERVICE_ACCOUNT:SERVICE_SECRET" \
  "https://data.mixpanel.com/api/2.0/export?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&project_id=PROJECT_ID" \
  | head -500 | python3 -c '
import sys, json, datetime
f = datetime.datetime.utcfromtimestamp
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: p = json.loads(line)["properties"]
    except Exception: continue
    api = p.get("$mp_api_timestamp_ms")
    if not api: continue
    t = p["time"]
    print("skew: %.3f h" % ((t*1000 - api)/3600000.0))
    n += 1
    if n >= 8: break
'
```

Set the patch to the observed skew, rounded to whole hours.

## Apply

```bash
sudo docker cp ops/container-patches/patch-mixpanel-offset.cjs 26fa452088bc:/tmp/
sudo docker exec 26fa452088bc node /tmp/patch-mixpanel-offset.cjs 0
sudo docker exec 26fa452088bc node --check /app/apps/worker/dist/index.js && echo PARSES_OK
sudo docker restart 26fa452088bc
```

Pass a different number to change it (`3` for Asia/Riyadh). Idempotent.

## Verify

```bash
sudo docker exec 26fa452088bc grep -o 'props.time \* 1e3 - [0-9.]* \* 36e5' \
  /app/apps/worker/dist/index.js     # -> props.time * 1e3 - 0 * 36e5
```

## Note on the upstream fix

The PR replaces this hardcoded constant with a `timezone` field on the Mixpanel
import config, resolved **per instant** via `Intl` so DST-observing projects
convert correctly on both sides of a transition. Riyadh has no DST so a
constant is safe for us; it would not be for e.g. `Europe/Stockholm`.

The dashboard's import form does not expose the field yet — that's follow-up.

## Rollback

```bash
sudo docker exec 26fa452088bc cp /app/apps/worker/dist/index.js.pre-offset \
  /app/apps/worker/dist/index.js
sudo docker restart 26fa452088bc
```
