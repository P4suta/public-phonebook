import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import {
  DatasetFileListingSchema,
  DirectoryDeltaListingSchema,
  datasetListingPath,
  SearchIndexLocationSchema,
  SearchRankingLocationSchema,
} from "@public-phonebook/directory/dataset-storage";
import { directoryArchiveFormat } from "@public-phonebook/directory/directory-archive";
import * as v from "valibot";
import {
  contractOrigin,
  directoryFixture,
  type FixtureRevision,
  type FixtureScenario,
  fixturePort,
} from "./directory-fixture.ts";
import { requireSampleCityEnvironment } from "./sample-city.ts";

const listenHostname = "127.0.0.1";
const loopbackHostnames = [listenHostname, "localhost"];
const httpOk = 200;
const httpServerError = 500;
const commandArgumentOffset = 2;
const corpusDestination =
  "apps/ios/Tests/PhonebookKitTests/DirectoryContract.json";
const forwardedHeaders = ["range", "if-range", "if-none-match"] as const;
const highestPort = 65_535;

/** The port to serve on: `PHONEBOOK_FIXTURE_PORT` when the iOS gate picked one, or the development port. */
export function servePort(environment: NodeJS.ProcessEnv): number {
  const chosen = environment.PHONEBOOK_FIXTURE_PORT;
  if (chosen === undefined) return fixturePort;
  return v.parse(
    v.pipe(
      v.string(),
      v.regex(/^[0-9]+$/u),
      v.transform(Number),
      v.integer(),
      v.minValue(1),
      v.maxValue(highestPort),
    ),
    chosen,
  );
}

export function fixtureScenario(
  environment: NodeJS.ProcessEnv,
): FixtureScenario {
  const scenario = v.parse(
    v.picklist(["contract", "sample-city"]),
    environment.PHONEBOOK_FIXTURE_SCENARIO ?? "contract",
  );
  if (scenario === "sample-city") requireSampleCityEnvironment(environment);
  return scenario;
}

async function writeSampleBundle(
  fixture: Awaited<ReturnType<typeof directoryFixture>>,
  directory: string,
): Promise<void> {
  const response = await fixture.fetch(
    new Request(new URL(datasetListingPath, contractOrigin)),
  );
  const listing = v.parse(DatasetFileListingSchema, await response.json());
  const archive = listing.files.find(
    (file) => file.format === directoryArchiveFormat,
  );
  if (!archive) throw new Error("The sample fixture has no directory archive");
  const download = await fixture.fetch(
    new Request(new URL(archive.url, contractOrigin)),
  );
  if (!download.ok) throw new Error("The sample archive download failed");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "directory.tsv.br"),
    new Uint8Array(await download.arrayBuffer()),
  );
  await writeFile(
    join(directory, "directory.json"),
    JSON.stringify({
      snapshot: listing.snapshot,
      generatedAt: listing.generatedAt,
      contacts: listing.contacts,
      format: archive.format,
      bytes: archive.bytes,
      sha256: archive.sha256,
    }),
  );
}

interface ContractResponse {
  readonly revision: FixtureRevision;
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly encoding?: "base64";
}

/**
 * Records the baseline import, then the update to the next revision through its delta and its complete archive.
 */
export async function contractResponses(): Promise<
  readonly ContractResponse[]
> {
  return [
    ...(await revisionResponses("baseline")),
    ...(await revisionResponses("updated")),
  ];
}

async function revisionResponses(
  revision: FixtureRevision,
): Promise<readonly ContractResponse[]> {
  const fixture = await directoryFixture({ revision });
  const responses: ContractResponse[] = [];
  async function request(path: string, binary = false): Promise<string> {
    const response = await fixture.fetch(
      new Request(new URL(path, contractOrigin)),
    );
    const headers: Record<string, string> = {};
    for (const name of ["Content-Type", "X-Dataset-Snapshot"])
      headers[name] = response.headers.get(name) ?? "";
    const status = response.status;
    if (binary) {
      let bytes = "";
      for (const byte of new Uint8Array(await response.arrayBuffer()))
        bytes += String.fromCharCode(byte);
      const body = btoa(bytes);
      responses.push({
        revision,
        path,
        status,
        headers,
        body,
        encoding: "base64",
      });
      return body;
    }
    const body = await response.text();
    responses.push({ revision, path, status, headers, body });
    return body;
  }
  try {
    const raw: unknown = JSON.parse(await request(datasetListingPath));
    const listing = v.parse(DatasetFileListingSchema, raw);
    const archive = listing.files.find(
      (file) => file.format === directoryArchiveFormat,
    );
    if (!archive) throw new Error("The provider contract has no archive");
    if (revision === "updated") {
      const deltas: unknown = JSON.parse(await request(listing.datasetDeltas));
      for (const delta of v.parse(DirectoryDeltaListingSchema, deltas).deltas)
        await request(delta.url, true);
    }
    await request(archive.url, true);
    const index = v.parse(
      SearchIndexLocationSchema,
      JSON.parse(await request("/api/search-index")),
    );
    const ranking = v.parse(
      SearchRankingLocationSchema,
      JSON.parse(await request("/api/search-ranking")),
    );
    await request(`${index.url}/download`, true);
    await request(`${ranking.url}/download`, true);
    return responses;
  } finally {
    await fixture.dispose();
  }
}

async function serve(): Promise<void> {
  const scenario = fixtureScenario(process.env);
  const revision = v.parse(
    v.picklist(["baseline", "updated"]),
    process.env.PHONEBOOK_FIXTURE_REVISION ?? "baseline",
  );
  const fixture = await directoryFixture({ revision, scenario });
  if (scenario === "sample-city") {
    const directory = process.env.PHONEBOOK_FIXTURE_SAMPLE_BUNDLE;
    if (!directory)
      throw new Error("Sample capture requires its bundle directory");
    await writeSampleBundle(fixture, directory);
  }
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
      const headers = new Headers();
      // Resumed downloads send these, so the fixture answers them like the Worker.
      for (const name of forwardedHeaders) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(new URL(incoming.url ?? "/", origin), {
        method: incoming.method ?? "GET",
        headers,
        signal: controller.signal,
      });
      const response = await fixture.fetch(request);
      if (
        process.env.PHONEBOOK_FIXTURE_INCOMPLETE === "datasets" &&
        new URL(request.url).pathname === datasetListingPath
      ) {
        outgoing.writeHead(httpOk, {
          ...Object.fromEntries(response.headers),
          "Content-Length": "1048576",
        });
        outgoing.write("{");
        console.info(
          JSON.stringify({
            operation: "fixture.incomplete",
            route: datasetListingPath,
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
  server.listen(servePort(process.env), listenHostname);
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
