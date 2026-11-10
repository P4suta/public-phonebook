import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { versionHeader } from "../apps/web/src/server/version-header.ts";
import { serveBuiltWorker } from "./built-worker-server.ts";
import { seedLocalData } from "./local-data.ts";
import { requireCommand } from "./process.ts";
import {
  awaitExpectedVersion,
  publicAccess,
  rehearsalOrigin,
} from "./public-request.ts";

const commandArgumentOffset = 2;
const rehearsalState = ".local/rehearsal-state";
const rehearsalTls = ".local/rehearsal-tls";
const probeLedgers = ".local/probe-ledgers";
const loopbackAddress = new URL(rehearsalOrigin).hostname;

interface LoopbackCertificate {
  readonly key: string;
  readonly cert: string;
  readonly certPath: string;
}

/** Issues a one-day certificate for the loopback address, so Node verifies the preview instead of skipping verification. */
async function loopbackCertificate(): Promise<LoopbackCertificate> {
  await rm(rehearsalTls, { recursive: true, force: true });
  await mkdir(rehearsalTls, { recursive: true });
  const keyPath = resolve(rehearsalTls, "key.pem");
  const certPath = resolve(rehearsalTls, "cert.pem");
  await requireCommand("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${loopbackAddress}`,
    "-addext",
    `subjectAltName=IP:${loopbackAddress}`,
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
  return {
    key: await readFile(keyPath, "utf8"),
    cert: await readFile(certPath, "utf8"),
    certPath,
  };
}

/** Reads the version that the preview's version metadata binding drew for this run. */
async function previewVersion(): Promise<string> {
  const response = await fetch(new URL("/api/catalog", rehearsalOrigin), {
    redirect: "manual",
  });
  await response.body?.cancel();
  const version = response.headers.get(versionHeader);
  if (!response.ok || !version)
    throw new Error("The preview didn't answer with its version");
  return version;
}

/**
 * Runs the production public checks on the built preview with the bundle's data.
 * The checks keep their probe budget, workers, version checks, and request routing, so a defect in them or in the site fails here before a workflow stages a candidate.
 */
async function rehearse(bundle: string): Promise<void> {
  const port = Number(new URL(rehearsalOrigin).port);
  await requireCommand("npm", ["run", "build"]);
  await rm(rehearsalState, { recursive: true, force: true });
  await seedLocalData(bundle, { state: rehearsalState, port });
  const tls = await loopbackCertificate();
  setDefaultCACertificates([...getCACertificates("default"), tls.cert]);
  const runtime = await serveBuiltWorker({ port, state: rehearsalState, tls });
  try {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DIAL_PUBLIC_ORIGIN: rehearsalOrigin,
      DIAL_PUBLIC_REHEARSAL: "preview",
      DIAL_PUBLIC_BUNDLE: bundle,
      DIAL_PUBLIC_VERSION: await previewVersion(),
      DIAL_PUBLIC_VERSION_MODE: "required",
      DIAL_PROBE_LEDGER: resolve(probeLedgers, `${randomUUID()}.json`),
      NODE_EXTRA_CA_CERTS: tls.certPath,
    };
    await awaitExpectedVersion(publicAccess(environment));
    await requireCommand(
      "npm",
      [
        "exec",
        "--no",
        "--",
        "playwright",
        "test",
        "--config",
        join("apps", "web", "tests", "public", "playwright.config.ts"),
      ],
      undefined,
      environment,
    );
  } finally {
    await runtime.dispose();
  }
  console.info(
    JSON.stringify({ operation: "public.rehearsal", bundle, result: "passed" }),
  );
}

if (import.meta.main) {
  const [bundle, ...extra] = process.argv.slice(commandArgumentOffset);
  if (!bundle || extra.length)
    throw new Error("Usage: node tools/public-rehearsal.ts BUNDLE_DIRECTORY");
  await rehearse(resolve(bundle));
}
