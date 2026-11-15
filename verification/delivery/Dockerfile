FROM docker.io/library/rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c

ADD --checksum=sha256:32e2b484d73ede0bbf64a2cf0879c4259422497d8aec4ee67d448de9ae7843d3 https://github.com/model-checking/kani/releases/download/kani-0.68.0/kani-0.68.0-x86_64-unknown-linux-gnu.tar.gz /tmp/kani.tar.gz

RUN cargo install --locked kani-verifier --version 0.68.0 \
    && cargo kani setup --use-local-bundle /tmp/kani.tar.gz \
    && rm /tmp/kani.tar.gz \
    && cargo kani --version
