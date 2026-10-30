import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load } from "cheerio";
import * as v from "valibot";
import {
  singleCandidate,
  sourceRowsAccounted,
} from "../../src/core/collection-policy.ts";
import {
  type Contact,
  type Source,
  SourceSchema,
} from "../../src/core/models.ts";
import { type SourceArtifact as Artifact, ArtifactStore } from "./artifacts.ts";
import { extractTables } from "./extract.ts";
import {
  CollectionManifestSchema,
  type DirectorySource,
  type SourceFormat,
} from "./models.ts";
import { readPdfTables } from "./read-pdf.ts";
import {
  decodeSourceText,
  readCsvTables,
  readHtmlTables,
  readWorkbookTables,
} from "./read-tables.ts";
import { SchoolRegistry } from "./school-registry.ts";

const sourceHashWidth = 32;
const collectionConcurrency = 3;
const maximumAccountedRows = 1000000000;
const jsonIndentation = 2;
const urlFormats = {
  csv: "csv",
  xls: "workbook",
  xlsx: "workbook",
  pdf: "pdf",
  html: "html",
  htm: "html",
} as const;

function extensionFormat(url: string): SourceFormat | null {
  const extension = new URL(url).pathname.split(".").at(-1)?.toLowerCase();
  return (
    Object.entries(urlFormats).find(([key]) => key === extension)?.[1] ?? null
  );
}

async function discover(
  store: ArtifactStore,
  source: DirectorySource,
): Promise<readonly { artifact: Artifact; format: SourceFormat }[]> {
  const root = await store.get(source.url);
  if (!source.discovery) return [{ artifact: root, format: source.format }];
  const found = new Map<string, { artifact: Artifact; format: SourceFormat }>();
  const visited = new Set([source.url]);
  let frontier = [root];
  const pattern = new RegExp(source.discovery.pattern, "iu");
  for (let depth = 0; depth < source.discovery.depth; depth += 1) {
    const next: Artifact[] = [];
    for (const page of frontier) {
      const $ = load(decodeSourceText(await store.read(page)));
      for (const node of $("a[href]").toArray()) {
        const href = $(node).attr("href");
        if (!href) continue;
        const url = new URL(href, page.resolvedUrl);
        url.hash = "";
        const label =
          $(node).text().trim() || $(node).find("img").attr("alt") || "";
        if (
          url.protocol !== "https:" ||
          !pattern.test(`${label} ${decodeURI(url.href)}`) ||
          visited.has(url.href)
        )
          continue;
        if (visited.size > source.discovery.maxPages)
          throw new Error(`Discovery page limit exceeded: ${source.id}`);
        visited.add(url.href);
        const format = extensionFormat(url.href);
        if (!format) continue;
        if (source.discovery.formats.includes(format))
          found.set(url.href, { artifact: await store.get(url.href), format });
        else if (format === "html" && depth + 1 < source.discovery.depth)
          next.push(await store.get(url.href));
      }
    }
    frontier = next;
  }
  if (!found.size)
    throw new Error(`No published directory matched: ${source.id}`);
  return Array.from(found.values());
}

export async function collectDirectories(input: {
  manifest: string;
  output: string;
  cache: string;
  offline: boolean;
  preferCached?: boolean;
  only?: string;
}): Promise<void> {
  const manifestValue: unknown = JSON.parse(
    await readFile(input.manifest, "utf8"),
  );
  const manifest = v.parse(CollectionManifestSchema, manifestValue);
  const store = new ArtifactStore(input.cache, {
    offline: input.offline,
    preferCached: input.preferCached ?? false,
  });
  const registryArtifacts: Artifact[] = [];
  const registryInputs: Uint8Array[] = [];
  for (const url of manifest.schoolRegistry) {
    const artifact = await store.get(url);
    registryArtifacts.push(artifact);
    registryInputs.push(await store.read(artifact));
  }
  const registry = new SchoolRegistry(registryInputs, manifest.registryAsOf);
  const contacts = new Map<string, Contact>();
  const candidates = new Map<string, Contact[]>();
  const conflicts: { id: string; sources: string[] }[] = [];
  const sources: Source[] = [];
  const reports: unknown[] = [];
  const failures: { id: string; error: string }[] = [];
  const plans = manifest.sources.filter(
    (source) => !input.only || new RegExp(input.only, "u").test(source.id),
  );
  if (!plans.length) throw new Error("No collection source selected");
  let nextPlan = 0;
  const runPlan = async (plan: DirectorySource): Promise<void> => {
    try {
      const index = await store.get(
        plan.provenanceUrl ?? plan.indexUrl ?? plan.url,
      );
      const license = await store.get(plan.provenanceUrl ?? plan.licenseUrl);
      const resources = await discover(store, plan);
      let accepted = 0;
      for (const { artifact, format } of resources) {
        const bytes = await store.read(artifact);
        const tables =
          format === "csv"
            ? readCsvTables(bytes)
            : format === "workbook"
              ? readWorkbookTables(bytes)
              : format === "html"
                ? readHtmlTables(decodeSourceText(bytes), plan.selector)
                : await readPdfTables(bytes, plan.pdfColumns);
        if (!tables) throw new Error(`Unsupported source format: ${format}`);
        const sourceId = `${plan.id}:${createHash("sha256")
          .update(
            JSON.stringify([
              artifact.url,
              artifact.sha256,
              index.sha256,
              license.sha256,
              manifest.registryAsOf,
              ...registryArtifacts.map((item) => item.sha256),
            ]),
          )
          .digest("hex")
          .slice(0, sourceHashWidth)}`;
        const result = extractTables({
          source: plan,
          tables,
          registry,
          retrievedAt: artifact.retrievedAt,
          sourceUrl: artifact.url,
          sourceId,
        });
        const source = v.parse(SourceSchema, {
          id: sourceId,
          publisher: plan.publisher.replace(/^[0-9]{6}_/u, ""),
          ...(plan.title ? { title: plan.title } : {}),
          url: artifact.url,
          sha256: artifact.sha256,
          dataAsOf: plan.dataAsOf,
          retrievedAt: artifact.retrievedAt,
          indexUrl: index.url,
          indexSha256: index.sha256,
          licenseUrl: license.url,
          licenseSha256: license.sha256,
          artifacts: [
            artifact,
            index,
            license,
            ...(result.contacts.some((contact) =>
              contact.id.startsWith("school:"),
            )
              ? registryArtifacts
              : []),
          ].map((item) => ({
            url: item.url,
            sha256: item.sha256,
            retrievedAt: item.retrievedAt,
          })),
          rows: result.rows,
          accepted: result.contacts.length,
          missingPhone: result.missingPhone,
          invalid: result.invalid,
          duplicate: result.duplicate,
          issues: result.issues,
        });
        const excluded = Object.values(source.issues).reduce(
          (sum, value) => sum + value,
          0,
        );
        if (
          [
            source.rows,
            source.accepted,
            source.missingPhone,
            source.invalid,
            source.duplicate,
            excluded,
          ].some((count) => count > maximumAccountedRows)
        )
          throw new Error("Source row accounting exceeds the verified bound");
        if (
          !sourceRowsAccounted(
            source.rows,
            source.accepted,
            source.missingPhone,
            source.invalid,
            source.duplicate,
            excluded,
          )
        )
          throw new Error(`Source outcomes do not reconcile: ${sourceId}`);
        if (result.contacts.length) sources.push(source);
        accepted += result.contacts.length;
        for (const contact of result.contacts) {
          const group = candidates.get(contact.id) ?? [];
          group.push(contact);
          candidates.set(contact.id, group);
        }
        reports.push({
          plan: plan.id,
          source: sourceId,
          ...result,
          contacts: result.contacts.length,
        });
        console.info(
          JSON.stringify({
            phase: "collection",
            source: sourceId,
            accepted: result.contacts.length,
            rows: result.rows,
            issues: result.issues,
          }),
        );
      }
      if (accepted < plan.minimumContacts)
        throw new Error(
          `Directory contact floor failed: ${plan.id}: ${accepted} < ${plan.minimumContacts}`,
        );
    } catch (error) {
      failures.push({
        id: plan.id,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(JSON.stringify(failures.at(-1)));
    }
  };
  await Promise.all(
    Array.from({ length: collectionConcurrency }, async () => {
      while (nextPlan < plans.length) {
        const plan = plans[nextPlan++];
        if (plan) await runPlan(plan);
      }
    }),
  );
  sources.sort((a, b) => a.id.localeCompare(b.id));
  for (const [id, group] of candidates) {
    const dated = group.filter((contact) =>
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(contact.dataAsOf),
    );
    const latest = dated
      .map((contact) => contact.dataAsOf)
      .sort()
      .at(-1);
    const cohort = (
      latest ? dated.filter((contact) => contact.dataAsOf === latest) : group
    ).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const signatures = new Set(
      cohort.map((contact) =>
        contact.phones
          .map((phone) => phone.e164)
          .sort()
          .join(","),
      ),
    );
    const selected = cohort[0];
    if (selected && singleCandidate(signatures.size))
      contacts.set(id, selected);
    else
      conflicts.push({
        id,
        sources: cohort.map((contact) => contact.sourceId),
      });
  }
  await mkdir(input.output, { recursive: true });
  const ordered = Array.from(contacts.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  await writeFile(
    join(input.output, "contacts.jsonl"),
    ordered.map((contact) => JSON.stringify(contact)).join("\n") + "\n",
  );
  await writeFile(
    join(input.output, "sources.json"),
    JSON.stringify(sources, null, jsonIndentation) + "\n",
  );
  const coverage = new Map<string, number>();
  for (const contact of ordered)
    coverage.set(
      `${contact.prefectureCode}:${contact.category}`,
      (coverage.get(`${contact.prefectureCode}:${contact.category}`) ?? 0) + 1,
    );
  await writeFile(
    join(input.output, "collection-report.json"),
    JSON.stringify(
      {
        complete: failures.length === 0,
        registrySchools: registry.schools.length,
        contacts: contacts.size,
        conflicts,
        coverage: Object.fromEntries(
          Array.from(coverage).sort(([a], [b]) => a.localeCompare(b)),
        ),
        plans: reports,
        failures,
      },
      null,
      jsonIndentation,
    ) + "\n",
  );
  console.info(
    JSON.stringify({
      phase: "collection.complete",
      contacts: contacts.size,
      sources: sources.length,
      failures,
    }),
  );
  if (failures.length)
    throw new Error(
      `${failures.length} collection sources failed; inspect collection-report.json`,
    );
}
