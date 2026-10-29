FROM rust:1.99.0-slim-bookworm@sha256:ba81bc3eaa4422af576c0262515d96b0111a628a6ccc2c86557cf55c9a4bbee0 AS build
ARG TARGETARCH
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY xtask ./xtask
COPY static ./static
COPY sources ./sources
ENV CARGO_BUILD_JOBS=2
RUN --mount=type=cache,id=phonebook-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=phonebook-target-${TARGETARCH},target=/app/target \
    cargo build --locked --release -p public-phonebook \
    && cp target/release/public-phonebook /app/public-phonebook

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY --from=build /app/public-phonebook /usr/local/bin/public-phonebook
COPY --chown=0:0 --chmod=0444 data/service/phonebook.sqlite data/service/snapshot.json data/service/directory.lock /data/
RUN chmod 0555 /data
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["public-phonebook", "--data", "/data", "serve", "--require-manifest", "--host", "0.0.0.0", "--port", "8080"]
