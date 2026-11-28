FROM docker.io/library/rust:1.100.0-bookworm@sha256:75d26c23c24cc6ea1cdabf0714a6bff8fd7bf3248716043fd7ae86dac7f41b94

ADD --checksum=sha256:32e2b484d73ede0bbf64a2cf0879c4259422497d8aec4ee67d448de9ae7843d3 https://github.com/model-checking/kani/releases/download/kani-0.68.0/kani-0.68.0-x86_64-unknown-linux-gnu.tar.gz /tmp/kani.tar.gz

RUN cargo install --locked kani-verifier --version 0.68.0 \
    && cargo kani setup --use-local-bundle /tmp/kani.tar.gz \
    && rm /tmp/kani.tar.gz \
    && cargo kani --version
