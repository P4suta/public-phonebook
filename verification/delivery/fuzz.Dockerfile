FROM docker.io/library/rust:1.99.1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b

ENV CARGO_BUILD_JOBS=2
RUN rustup toolchain install nightly-2026-08-21 --profile minimal \
    && cargo install --locked cargo-fuzz --version 0.13.2

COPY tools/delivery/core/Cargo.toml /work/tools/delivery/core/Cargo.toml
COPY tools/delivery/core/src /work/tools/delivery/core/src
COPY tools/delivery/fuzz/Cargo.toml tools/delivery/fuzz/Cargo.lock /work/tools/delivery/fuzz/
COPY tools/delivery/fuzz/contract.rs /work/tools/delivery/fuzz/contract.rs
COPY tools/delivery/fuzz/fuzz_targets /work/tools/delivery/fuzz/fuzz_targets
COPY tools/delivery/fuzz/corpus /work/tools/delivery/fuzz/corpus
WORKDIR /work/tools/delivery/fuzz
RUN cargo +nightly-2026-08-21 fuzz build --fuzz-dir . version_identities
