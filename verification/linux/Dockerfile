FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install --yes --no-install-recommends gcc=4:13.2.0-7ubuntu1 libc6-dev=2.39-0ubuntu8.9 shellcheck=0.9.0-1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/jdxcode/mise:2026.11.2@sha256:39cd8aad519a3dbc860eceb64dfd8cb5efe4cdbb8ad741a6867b544b2787b79c /usr/local/bin/mise /usr/local/bin/mise

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
