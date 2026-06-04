# syntax=docker/dockerfile:1

###############################################################################
# Build stage — compiles the native zca-cloud-server binary.
# Migrations are embedded at compile time via sqlx::migrate!("./migrations"),
# so the SQL files must be present here, but NO database is needed to build.
###############################################################################
FROM rust:1-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Pre-build dependencies for layer caching: a dummy crate with only the
#    manifests, so this expensive layer is reused until Cargo.toml/lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src

# 2) Build the real binary against the cached dependency layer.
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release

###############################################################################
# Runtime stage — slim image with just the binary + TLS roots.
###############################################################################
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group zca

COPY --from=builder /app/target/release/zca-cloud-server /usr/local/bin/zca-cloud-server

USER zca
# Inside the container bind all interfaces; the host maps the port back to 127.0.0.1.
ENV ZCA_CLOUD_BIND=0.0.0.0:37880
EXPOSE 37880

ENTRYPOINT ["zca-cloud-server"]

###############################################################################
# Dev stage — hot-reloads the server on source changes via cargo-watch.
# Used by docker-compose.dev.yml: source is bind-mounted, and dependencies +
# build artifacts live in named volumes for fast incremental rebuilds.
# NOT for production (use the `runtime` target for that).
###############################################################################
FROM rust:1-bookworm AS dev

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-watch --locked

WORKDIR /app
ENV ZCA_CLOUD_BIND=0.0.0.0:37880
EXPOSE 37880

# --poll makes file-change detection reliable across the macOS↔Linux bind mount.
CMD ["cargo", "watch", "--poll", "-w", "src", "-w", "migrations", "-w", "Cargo.toml", "-x", "run"]
