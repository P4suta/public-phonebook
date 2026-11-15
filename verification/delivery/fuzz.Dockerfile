FROM docker.io/library/rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c

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
