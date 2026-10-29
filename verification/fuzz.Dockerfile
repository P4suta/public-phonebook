FROM rust:1.99.0-slim-bookworm@sha256:ba81bc3eaa4422af576c0262515d96b0111a628a6ccc2c86557cf55c9a4bbee0
ENV CARGO_BUILD_JOBS=2
RUN rustup set auto-self-update disable \
 && rustup toolchain install nightly-2026-10-22 --profile minimal \
 && cargo install cargo-fuzz --version 0.13.2 --locked
RUN apt-get update \
 && apt-get install --yes --no-install-recommends g++=4:12.2.0-3 g++-12=12.2.0-14+deb12u1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY xtask ./xtask
COPY fuzz ./fuzz
ENV CARGO_TARGET_DIR=/fuzz-target
RUN cargo fetch --manifest-path fuzz/Cargo.toml --locked \
 && CARGO_NET_OFFLINE=true cargo +nightly-2026-10-22 fuzz build \
 && cp /fuzz-target/x86_64-unknown-linux-gnu/release/core_contracts /usr/local/bin/phonebook-fuzz \
 && cp /fuzz-target/x86_64-unknown-linux-gnu/release/reject_false_roundtrip /usr/local/bin/phonebook-fuzz-negative \
 && cargo build --locked --release -p xtask \
 && cp /fuzz-target/release/xtask /usr/local/bin/phonebook-verification
ENV CARGO_NET_OFFLINE=true
