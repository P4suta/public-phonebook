import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import * as v from "valibot";
import { DirectoryDiscoverySchema } from "../src/core/api-contract.ts";
import { directoryArchiveFile } from "../src/core/directory-archive.ts";
import { VersionedDatasetManifestSchema } from "../src/core/models.ts";
import {
  contractOrigin,
  directoryFixture,
  fixturePort,
} from "./directory-fixture.ts";

const listenHostname = "127.0.0.1";
const loopbackHostnames = [listenHostname, "localhost"];
const httpOk = 200;
const httpServerError = 500;
const commandArgumentOffset = 2;
const corpusDestination = "ios/Tests/PhonebookKitTests/DirectoryContract.json";

interface ContractResponse {
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly encoding?: "base64";
}

export async function contractResponses(): Promise<
  readonly ContractResponse[]
> {
  const fixture = await directoryFixture();
  const responses: ContractResponse[] = [];
  async function request(path: string, binary = false): Promise<string> {
    const response = await fixture.fetch(
      new Request(new URL(path, contractOrigin)),
    );
    const headers: Record<string, string> = {};
    for (const name of [
      "Content-Type",
      "X-Dataset-Snapshot",
      "X-Directory-API-Version",
    ])
      headers[name] = response.headers.get(name) ?? "";
    const status = response.status;
    if (binary) {
      let bytes = "";
      for (const byte of new Uint8Array(await response.arrayBuffer()))
        bytes += String.fromCharCode(byte);
      const body = btoa(bytes);
      responses.push({ path, status, headers, body, encoding: "base64" });
      return body;
    }
    const body = await response.text();
    responses.push({ path, status, headers, body });
    return body;
  }
  try {
    const raw: unknown = JSON.parse(await request("/api/v1"));
    const discovery = v.parse(DirectoryDiscoverySchema, raw);
    await request(discovery.catalog);
    const listing: unknown = JSON.parse(await request(discovery.datasets));
    const archive = v
      .parse(VersionedDatasetManifestSchema, listing)
      .files.find((file) => file.file === directoryArchiveFile);
    if (!archive) throw new Error("The provider contract has no archive");
    await request(archive.url, true);
    return responses;
  } finally {
    await fixture.dispose();
  }
}

async function serve(): Promise<void> {
  const revision = v.parse(
    v.picklist(["baseline", "updated"]),
    process.env.PHONEBOOK_FIXTURE_REVISION ?? "baseline",
  );
  const fixture = await directoryFixture({ revision });
  const publicOrigin = process.env.PHONEBOOK_FIXTURE_PUBLIC_ORIGIN;
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Invalid public fixture origin");
  }
  async function respond(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const received = new Date();
    const started = performance.now();
    const controller = new AbortController();
    outgoing.once("close", () => {
      controller.abort();
      console.info(
        JSON.stringify({
          operation: "fixture.request",
          path: incoming.url,
          received: received.toISOString(),
          status: outgoing.writableFinished ? outgoing.statusCode : "closed",
          milliseconds: Math.round(performance.now() - started),
        }),
      );
    });
    try {
      const forwarded = incoming.headers["x-fixture-origin"];
      const origin =
        publicOrigin ??
        (typeof forwarded === "string"
          ? forwarded
          : `http://${incoming.headers.host}`);
      const parsed = new URL(origin);
      if (
        !publicOrigin &&
        (parsed.protocol !== "http:" ||
          !loopbackHostnames.includes(parsed.hostname))
      )
        throw new Error("Invalid fixture origin");
      const request = new Request(new URL(incoming.url ?? "/", origin), {
        method: incoming.method ?? "GET",
        signal: controller.signal,
      });
      const response = await fixture.fetch(request);
      if (
        process.env.PHONEBOOK_FIXTURE_INCOMPLETE === "contacts" &&
        new URL(request.url).pathname === "/api/v1/contacts"
      ) {
        outgoing.writeHead(httpOk, {
          ...Object.fromEntries(response.headers),
          "Content-Length": "1048576",
        });
        outgoing.write("{");
        console.info(
          JSON.stringify({
            operation: "fixture.incomplete",
            route: "/api/v1/contacts",
          }),
        );
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(error);
        outgoing.writeHead(httpServerError).end();
      }
    }
  }
  const server = createServer((incoming, outgoing) => {
    void respond(incoming, outgoing);
  });
  server.listen(fixturePort, listenHostname);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
      void fixture.dispose();
    });
}

if (import.meta.main) {
  const command = process.argv[commandArgumentOffset];
  if (command === "--corpus")
    console.info(JSON.stringify(await contractResponses()));
  else if (command === "--write-corpus") {
    await mkdir(dirname(corpusDestination), { recursive: true });
    await writeFile(
      corpusDestination,
      `${JSON.stringify(await contractResponses())}\n`,
    );
    console.info(
      JSON.stringify({
        operation: "api.contract.write",
        destination: corpusDestination,
      }),
    );
  } else if (command === "--serve") await serve();
  else throw new Error("Use --corpus, --write-corpus, or --serve");
}
