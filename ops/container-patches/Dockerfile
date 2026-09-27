# Patched worker image.
#
# Derives from the stock 2.3.0 worker and bakes in the four hot patches in this
# directory, so they survive a redeploy instead of living in a container's
# writable layer.
#
# Deriving rather than rebuilding from source is deliberate: it reproduces the
# bundle we have already verified in production, byte for byte, without
# introducing a different compiler, dependency tree or base image. The result
# is checked against that hash at build time and the build fails if it drifts.
#
# Build (on the Docker host — this Dokploy has no registry, images are local):
#
#   cd ops/container-patches
#   sudo docker build -t openpanel-worker:2.3.0-qoyod.1 .
#
# Then point the worker service at openpanel-worker:2.3.0-qoyod.1 instead of
# lindesvard/openpanel-worker:2 (which is a moving tag and can shift releases
# under you).

FROM lindesvard/openpanel-worker:2.3.0

# The bundle this image is built against. Guards against silently patching a
# different release if the base tag is ever repointed.
ARG EXPECTED_BASE_SHA=171845caca48a3f772fa240e9deace25b9f64398cd30ee4bda811936065d289a

# The bundle the four patches must produce. Verified against production on
# 2026-09-27.
ARG EXPECTED_PATCHED_SHA=77f434c04ffd287fe8353c97a9538b24728e3bb5bfcde701908b54cac36dd5ab

COPY patch-mixpanel-engage.cjs \
     patch-mixpanel-dates.cjs \
     patch-mixpanel-offset.cjs \
     patch-clickhouse-timeout.cjs \
     /tmp/patches/

# Order matters: 02 refuses to run without 01, 03 without 02. Each patcher
# aborts unless its anchor matches exactly once, so an unexpected bundle fails
# the build rather than being mangled.
RUN set -eu; \
    BUNDLE=/app/apps/worker/dist/index.js; \
    echo "$EXPECTED_BASE_SHA  $BUNDLE" | sha256sum -c - ; \
    node /tmp/patches/patch-mixpanel-engage.cjs     "$BUNDLE"; \
    node /tmp/patches/patch-mixpanel-dates.cjs      "$BUNDLE"; \
    node /tmp/patches/patch-mixpanel-offset.cjs   0 "$BUNDLE"; \
    node /tmp/patches/patch-clickhouse-timeout.cjs 3600000 "$BUNDLE"; \
    node --check "$BUNDLE"; \
    echo "$EXPECTED_PATCHED_SHA  $BUNDLE" | sha256sum -c - ; \
    rm -rf /tmp/patches "$BUNDLE".orig "$BUNDLE".pre-dates \
           "$BUNDLE".pre-offset "$BUNDLE".pre-timeout

# ENTRYPOINT, CMD, WORKDIR and ENV are inherited from the base image.
