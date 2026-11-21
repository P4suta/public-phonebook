FROM docker.io/library/rust:1.100.0-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea

ADD --checksum=sha256:32e2b484d73ede0bbf64a2cf0879c4259422497d8aec4ee67d448de9ae7843d3 https://github.com/model-checking/kani/releases/download/kani-0.68.0/kani-0.68.0-x86_64-unknown-linux-gnu.tar.gz /tmp/kani.tar.gz

RUN cargo install --locked kani-verifier --version 0.68.0 \
    && cargo kani setup --use-local-bundle /tmp/kani.tar.gz \
    && rm /tmp/kani.tar.gz \
    && cargo kani --version
