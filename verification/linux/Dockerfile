FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install --yes --no-install-recommends gcc=4:13.2.0-7ubuntu1 libc6-dev=2.39-0ubuntu8.9 shellcheck=0.9.0-1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/jdxcode/mise:2026.10.19@sha256:6bd2515bf27389f537921fc8c3e5a6579f15cf889a63a8432dc542670174e50a /usr/local/bin/mise /usr/local/bin/mise

ENV MISE_DATA_DIR=/opt/mise \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo

RUN mkdir -p /opt/mise /opt/rustup /opt/cargo/registry /toolchain /work/tools/ios-check/target /home/pwuser/.npm \
    && chown -R 1001:1001 /opt/mise /opt/rustup /opt/cargo /toolchain /work /home/pwuser

USER 1001:1001
WORKDIR /toolchain
COPY --chown=1001:1001 mise.toml ./
RUN mise trust /toolchain/mise.toml && mise install && mise ls --current

WORKDIR /work
