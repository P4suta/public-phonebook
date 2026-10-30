import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import * as v from "valibot";
import { DirectoryDiscoverySchema } from "../src/core/api-contract.ts";
import { SearchResponseSchema } from "../src/core/models.ts";
import {
  contractOrigin,
  directoryFixture,
  fixturePort,
} from "./directory-fixture.ts";

const listenHostname = "127.0.0.1";
const loopbackHostnames = [listenHostname, "localhost"];
const continuationPageLimit = 8;
const httpOk = 200;
const httpServerError = 500;
const commandArgumentOffset = 2;
const corpusDestination = "ios/Tests/PhonebookKitTests/DirectoryContract.json";

interface ContractResponse {
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export async function contractResponses(): Promise<
  readonly ContractResponse[]
> {
  const fixture = await directoryFixture();
  const responses: ContractResponse[] = [];
  async function request(path: string): Promise<string> {
    const response = await fixture.fetch(
      new Request(new URL(path, contractOrigin)),
    );
    const body = await response.text();
    const headers: Record<string, string> = {};
    for (const name of [
      "Content-Type",
      "X-Dataset-Snapshot",
      "X-Directory-API-Version",
    ])
      headers[name] = response.headers.get(name) ?? "";
    responses.push({ path, status: response.status, headers, body });
    return body;
  }
  try {
    const raw: unknown = JSON.parse(await request("/api/v1"));
    const discovery = v.parse(DirectoryDiscoverySchema, raw);
    await request(discovery.catalog);
    const queries = [
      new URLSearchParams({ limit: "50" }),
      new URLSearchParams({ limit: "50", q: "試験" }),
      new URLSearchParams({ limit: "50", prefecture: "01" }),
      new URLSearchParams({ limit: "50", prefecture: "02" }),
    ];
    for (const query of queries) {
      let path: string | null = `${discovery.contacts}&${query}`;
      const visited = new Set<string>();
      while (path) {
        if (visited.size >= continuationPageLimit || visited.has(path))
          throw new Error(
            "The provider contract continuation did not terminate",
          );
        visited.add(path);
        const value: unknown = JSON.parse(await request(path));
        const page = v.parse(SearchResponseSchema, value);
        if (page.links.next) {
          const next = new URL(page.links.next);
          path = next.pathname + next.search;
        } else path = null;
      }
    }
    await request(`/api/v1/sources/test?snapshot=${discovery.snapshot}`);
    await request(
      `/api/v1/contacts/13%3Adental/contact.vcf?snapshot=${discovery.snapshot}`,
    );
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
    const controller = new AbortController();
    outgoing.once("close", () => controller.abort());
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
