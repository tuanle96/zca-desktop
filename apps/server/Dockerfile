# syntax=docker/dockerfile:1
#
# IMPORTANT: the build context is the REPO ROOT, not apps/server — the server
# path-depends on ../../crates/zca-types (the shared wire-contract crate). Build
# via docker-compose.dev.yml (which sets context: ../..) or:
#   docker build -f apps/server/Dockerfile --target runtime .
# from the repo root.

###############################################################################
# Build stage — compiles the native zca-cloud-server binary.
# Migrations are embedded at compile time via sqlx::migrate!("./migrations"),
# so the SQL files must be present here, but NO database is needed to build.
###############################################################################
FROM rust:1-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Path-dependency crate must be present for dependency resolution.
COPY crates/zca-types ./crates/zca-types

# 1) Pre-build dependencies for layer caching: manifests + a dummy main, so this
#    expensive layer is reused until Cargo.toml/lock (or zca-types) change.
COPY apps/server/Cargo.toml apps/server/Cargo.lock ./apps/server/
WORKDIR /repo/apps/server
RUN mkdir -p src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src

# 2) Build the real binary against the cached dependency layer.
COPY apps/server/src ./src
COPY apps/server/migrations ./migrations
RUN cargo build --release

###############################################################################
# Runtime stage — slim image with just the binary + TLS roots.
###############################################################################
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group zca

COPY --from=builder /repo/apps/server/target/release/zca-cloud-server /usr/local/bin/zca-cloud-server

USER zca
# Inside the container bind all interfaces; the host maps the port back to 127.0.0.1.
ENV ZCA_CLOUD_BIND=0.0.0.0:37880
EXPOSE 37880

ENTRYPOINT ["zca-cloud-server"]

###############################################################################
# Dev stage — hot-reloads the server on source changes via cargo-watch.
# Used by docker-compose.dev.yml: the repo's apps/server + crates/zca-types are
# bind-mounted under /repo, and dependencies + build artifacts live in named
# volumes for fast incremental rebuilds. NOT for production (use `runtime`).
###############################################################################
FROM rust:1-bookworm AS dev

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-watch --locked

WORKDIR /repo/apps/server
ENV ZCA_CLOUD_BIND=0.0.0.0:37880
EXPOSE 37880

# --poll makes file-change detection reliable across the macOS↔Linux bind mount.
# Also watch the shared crate so server rebuilds when the contract changes.
CMD ["cargo", "watch", "--poll", "-w", "src", "-w", "migrations", "-w", "Cargo.toml", "-w", "../../crates/zca-types", "-x", "run"]
