FROM mcr.microsoft.com/dotnet/runtime:8.0-bookworm-slim@sha256:4bed79c73dbc051b932b41c3b54ae112d8fdc26d415f6f99dd53ab8d0e99aeb2
ADD --checksum=sha256:1c27c879f4f7f056499c5393d422fd6c77ff6fbfa450c3f91f2f205ca788cc36 https://snapshot.debian.org/file/9e6e820439d5e0101295480100e2a97116796c84 /tmp/unzip_6.0-28+deb12u1_amd64.deb
RUN dpkg --install /tmp/unzip_6.0-28+deb12u1_amd64.deb && rm /tmp/unzip_6.0-28+deb12u1_amd64.deb
ADD --checksum=sha256:a46a9ff7cdd720f7955854c78e95df13f4cfe6b80691b05f8654fe19e8267179 https://github.com/dafny-lang/dafny/releases/download/v4.11.0/dafny-4.11.0-x64-ubuntu-22.04.zip /tmp/dafny.zip
RUN unzip -q /tmp/dafny.zip -d /opt && rm /tmp/dafny.zip && chmod +x /opt/dafny/dafny
WORKDIR /work
ENTRYPOINT ["/opt/dafny/dafny"]
