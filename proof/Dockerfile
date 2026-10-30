FROM mcr.microsoft.com/dotnet/runtime:8.0-bookworm-slim@sha256:4bed79c73dbc051b932b41c3b54ae112d8fdc26d415f6f99dd53ab8d0e99aeb2
RUN apt-get update && apt-get install -y --no-install-recommends unzip=6.0-28+deb12u1 && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:a46a9ff7cdd720f7955854c78e95df13f4cfe6b80691b05f8654fe19e8267179 https://github.com/dafny-lang/dafny/releases/download/v4.11.0/dafny-4.11.0-x64-ubuntu-22.04.zip /tmp/dafny.zip
RUN unzip -q /tmp/dafny.zip -d /opt && rm /tmp/dafny.zip && chmod +x /opt/dafny/dafny
WORKDIR /work
ENTRYPOINT ["/opt/dafny/dafny"]
