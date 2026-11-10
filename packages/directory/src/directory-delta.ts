import * as v from "valibot";
import {
  type DirectoryArchiveHeader,
  DirectoryArchiveHeaderSchema,
  directoryArchiveLimits,
} from "./directory-archive.ts";
import {
  copyAdmission,
  type DeltaAdmission,
  deltaAdmission,
} from "./directory-delta-policy.ts";
import { CountSchema, DigestSchema } from "./models.ts";
import type { Result } from "./result.ts";

const deltaSignature = "public-phonebook-directory-delta\t1";
/** The format that the delta listing declares for each delta, which line 1 spells with a TAB for the slash. */
export const directoryDeltaFormat = deltaSignature.replace("\t", "/");
// The archive signature of `directory-archive.ts`, which the reconstructed target starts with.
const archiveSignature = "public-phonebook-directory\t1";
const lineTerminator = "\n";
const fieldSeparator = "\t";
const listSeparator = "\u001f";
const copyPrefix = `=${fieldSeparator}`;
const addPrefix = `+${fieldSeparator}`;
const copyFieldCount = 3;
const rowFieldCount = 9;
const categoryField = 0;
const provenanceField = 6;
const originField = 7;
const confirmationField = 8;
const confirmedWithoutLink = "*";
const leadingLines = 3;
const decimalIndex = /^(?:0|[1-9][0-9]{0,8})$/u;
const decimalCount = /^[1-9][0-9]{0,8}$/u;

export const directoryDeltaFilePattern =
  /^directory-delta-[a-f0-9]{64}\.tsv\.br$/u;

export function directoryDeltaFile(base: string): string {
  return `directory-delta-${v.parse(DigestSchema, base)}.tsv.br`;
}

const IndexSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const IndexMapSchema = v.array(v.nullable(IndexSchema));
const ArchiveIdentitySchema = v.strictObject({
  snapshot: DigestSchema,
  archiveSha256: DigestSchema,
  sha256: DigestSchema,
  bytes: CountSchema,
  contacts: CountSchema,
});
export type DirectoryArchiveIdentity = v.InferOutput<
  typeof ArchiveIdentitySchema
>;

export const DirectoryDeltaHeaderSchema = v.pipe(
  v.strictObject({
    base: ArchiveIdentitySchema,
    target: ArchiveIdentitySchema,
    kept: CountSchema,
    added: CountSchema,
    removed: CountSchema,
    categories: v.pipe(
      IndexMapSchema,
      v.maxLength(directoryArchiveLimits.categories),
    ),
    provenances: v.pipe(
      IndexMapSchema,
      v.maxLength(directoryArchiveLimits.provenances),
    ),
    links: v.pipe(IndexMapSchema, v.maxLength(directoryArchiveLimits.links)),
  }),
  v.check(
    (header) =>
      header.base.snapshot !== header.target.snapshot &&
      header.kept + header.removed === header.base.contacts &&
      header.kept + header.added === header.target.contacts,
    "A directory delta must join two snapshots and account for every row",
  ),
);
export type DirectoryDeltaHeader = v.InferOutput<
  typeof DirectoryDeltaHeaderSchema
>;

export type DirectoryDeltaInstruction =
  | { readonly kind: "copy"; readonly start: number; readonly count: number }
  | { readonly kind: "add"; readonly row: string };

export interface DirectoryText {
  readonly headerLine: string;
  readonly header: DirectoryArchiveHeader;
  readonly rows: readonly string[];
}

export interface DirectoryDelta {
  readonly header: DirectoryDeltaHeader;
  readonly targetHeaderLine: string;
  readonly targetHeader: DirectoryArchiveHeader;
  readonly instructions: readonly DirectoryDeltaInstruction[];
}

interface IndexMaps {
  readonly categories: readonly (number | null)[];
  readonly provenances: readonly (number | null)[];
  readonly links: readonly (number | null)[];
}

interface DictionarySizes {
  readonly categories: number;
  readonly provenances: number;
  readonly links: number;
}

export interface DirectoryDeltaPlan {
  readonly maps: IndexMaps;
  readonly instructions: readonly DirectoryDeltaInstruction[];
  readonly kept: number;
  readonly added: number;
}

/** Computes SHA-256 incrementally so a client can hash the target while it writes it. */
export interface DeltaDigest {
  readonly update: (bytes: Uint8Array) => void;
  readonly digest: () => string;
}

export interface AppliedDirectoryDelta {
  readonly admission: DeltaAdmission;
  readonly text: string | null;
}

function failure<T>(error: string): Result<T, string> {
  return { ok: false, error };
}

function parseJson(text: string): Result<unknown, string> {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "The JSON line is invalid",
    );
  }
}

function lines(text: string): Result<readonly string[], string> {
  if (!text.endsWith(lineTerminator))
    return failure("The text must end with a line feed");
  return { ok: true, value: text.slice(0, -1).split(lineTerminator) };
}

function sizes(header: DirectoryArchiveHeader): DictionarySizes {
  return {
    categories: header.categories.length,
    provenances: header.provenances.length,
    links: header.links.length,
  };
}

export function readDirectoryText(text: string): Result<DirectoryText, string> {
  const split = lines(text);
  if (!split.ok) return split;
  const [signature, headerLine, ...rows] = split.value;
  if (signature !== archiveSignature || headerLine === undefined)
    return failure("Unsupported directory archive format");
  const json = parseJson(headerLine);
  if (!json.ok) return json;
  const header = v.safeParse(DirectoryArchiveHeaderSchema, json.value);
  if (!header.success)
    return failure("The directory archive header is invalid");
  if (header.output.contacts !== rows.length)
    return failure("The directory archive contact count differs from its rows");
  return { ok: true, value: { headerLine, header: header.output, rows } };
}

function mapIndex(
  text: string,
  map: readonly (number | null)[],
  size: number,
): string | null {
  if (!decimalIndex.test(text)) return null;
  const mapped = map[Number(text)];
  return mapped === undefined || mapped === null || mapped >= size
    ? null
    : String(mapped);
}

/** Rewrites a row's dictionary indices; a null provenance map blanks the provenance field. */
function mapFields(
  row: string,
  maps: IndexMaps,
  provenances: readonly (number | null)[] | null,
  target: DictionarySizes,
): string[] | null {
  const fields = row.split(fieldSeparator);
  if (fields.length !== rowFieldCount) return null;
  const category = mapIndex(
    fields[categoryField] ?? "",
    maps.categories,
    target.categories,
  );
  const provenance =
    provenances === null
      ? ""
      : mapIndex(
          fields[provenanceField] ?? "",
          provenances,
          target.provenances,
        );
  const origin = (fields[originField] ?? "")
    .split(listSeparator)
    .map((item) => mapIndex(item, maps.links, target.links));
  const confirmation = fields[confirmationField] ?? "";
  const confirmationLink =
    confirmation === "" || confirmation === confirmedWithoutLink
      ? confirmation
      : mapIndex(confirmation, maps.links, target.links);
  if (
    category === null ||
    provenance === null ||
    confirmationLink === null ||
    origin.some((item) => item === null)
  )
    return null;
  fields[categoryField] = category;
  fields[provenanceField] = provenance;
  fields[originField] = origin.join(listSeparator);
  fields[confirmationField] = confirmationLink;
  return fields;
}

function remapRow(
  row: string,
  maps: IndexMaps,
  target: DictionarySizes,
): string | null {
  return (
    mapFields(row, maps, maps.provenances, target)?.join(fieldSeparator) ?? null
  );
}

/** Maps each base provenance to the target provenance that the most otherwise identical rows use. */
function voteProvenances(
  base: DirectoryText,
  target: DirectoryText,
  maps: Omit<IndexMaps, "provenances">,
  sizes: DictionarySizes,
): (number | null)[] {
  const targetProvenances = new Map<string, Set<number>>();
  for (const row of target.rows) {
    const fields = row.split(fieldSeparator);
    const provenance = Number(fields[provenanceField]);
    fields[provenanceField] = "";
    const key = fields.join(fieldSeparator);
    const known = targetProvenances.get(key);
    if (known) known.add(provenance);
    else targetProvenances.set(key, new Set([provenance]));
  }
  const votes = base.header.provenances.map(() => new Map<number, number>());
  const unmapped = { ...maps, provenances: [] };
  for (const row of base.rows) {
    const fields = mapFields(row, unmapped, null, sizes);
    const source = row.split(fieldSeparator)[provenanceField] ?? "";
    const tally = decimalIndex.test(source) ? votes[Number(source)] : undefined;
    if (!fields || !tally) continue;
    for (const provenance of targetProvenances.get(
      fields.join(fieldSeparator),
    ) ?? [])
      tally.set(provenance, (tally.get(provenance) ?? 0) + 1);
  }
  return votes.map((tally) => {
    let chosen: number | null = null;
    let best = 0;
    for (const [provenance, count] of tally)
      if (
        count > best ||
        (count === best && chosen !== null && provenance < chosen)
      ) {
        chosen = provenance;
        best = count;
      }
    return chosen;
  });
}

/** Plans target-ordered copies of remapped base rows and literal additions for every other row. */
export function planDirectoryDelta(
  base: DirectoryText,
  target: DirectoryText,
): DirectoryDeltaPlan {
  const targetCategories = new Map(
    target.header.categories.map((category, index) => [category.id, index]),
  );
  const targetLinks = new Map(
    target.header.links.map((link, index) => [link, index]),
  );
  const partial = {
    categories: base.header.categories.map(
      (category) => targetCategories.get(category.id) ?? null,
    ),
    links: base.header.links.map((link) => targetLinks.get(link) ?? null),
  };
  const targetSizes = sizes(target.header);
  const maps: IndexMaps = {
    ...partial,
    provenances: voteProvenances(base, target, partial, targetSizes),
  };
  const available = new Map<string, number[]>();
  for (const [position, row] of base.rows.entries()) {
    const mapped = remapRow(row, maps, targetSizes);
    if (mapped === null) continue;
    const positions = available.get(mapped);
    if (positions) positions.push(position);
    else available.set(mapped, [position]);
  }
  const used = new Map<string, number>();
  const instructions: DirectoryDeltaInstruction[] = [];
  let kept = 0;
  let added = 0;
  for (const row of target.rows) {
    const cursor = used.get(row) ?? 0;
    const position = available.get(row)?.[cursor];
    if (position === undefined) {
      instructions.push({ kind: "add", row });
      added += 1;
      continue;
    }
    used.set(row, cursor + 1);
    kept += 1;
    const last = instructions.at(-1);
    if (last?.kind === "copy" && last.start + last.count === position)
      instructions[instructions.length - 1] = {
        ...last,
        count: last.count + 1,
      };
    else instructions.push({ kind: "copy", start: position, count: 1 });
  }
  return { maps, instructions, kept, added };
}

export function encodeDirectoryDelta(
  base: DirectoryText,
  target: DirectoryText,
  identities: {
    readonly base: Omit<DirectoryArchiveIdentity, "snapshot" | "contacts">;
    readonly target: Omit<DirectoryArchiveIdentity, "snapshot" | "contacts">;
  },
  plan: DirectoryDeltaPlan = planDirectoryDelta(base, target),
): string {
  const header = v.parse(DirectoryDeltaHeaderSchema, {
    base: {
      snapshot: base.header.snapshot,
      ...identities.base,
      contacts: base.rows.length,
    },
    target: {
      snapshot: target.header.snapshot,
      ...identities.target,
      contacts: target.rows.length,
    },
    kept: plan.kept,
    added: plan.added,
    removed: base.rows.length - plan.kept,
    categories: plan.maps.categories,
    provenances: plan.maps.provenances,
    links: plan.maps.links,
  });
  const body = plan.instructions.map((instruction) =>
    instruction.kind === "copy"
      ? `${copyPrefix}${instruction.start}${fieldSeparator}${instruction.count}`
      : `${addPrefix}${instruction.row}`,
  );
  return `${[deltaSignature, JSON.stringify(header), target.headerLine, ...body].join(lineTerminator)}${lineTerminator}`;
}

function decodeInstruction(line: string): DirectoryDeltaInstruction | null {
  if (line.startsWith(addPrefix)) {
    const row = line.slice(addPrefix.length);
    return row.split(fieldSeparator).length === rowFieldCount
      ? { kind: "add", row }
      : null;
  }
  const fields = line.split(fieldSeparator);
  const [marker, start = "", count = ""] = fields;
  if (
    `${marker}${fieldSeparator}` !== copyPrefix ||
    fields.length !== copyFieldCount ||
    !decimalIndex.test(start) ||
    !decimalCount.test(count)
  )
    return null;
  return { kind: "copy", start: Number(start), count: Number(count) };
}

function mapsFit(
  header: DirectoryDeltaHeader,
  target: DirectoryArchiveHeader,
): boolean {
  const limits = sizes(target);
  const fits = (map: readonly (number | null)[], size: number): boolean =>
    map.every((index) => index === null || index < size);
  return (
    fits(header.categories, limits.categories) &&
    fits(header.provenances, limits.provenances) &&
    fits(header.links, limits.links)
  );
}

/** Decodes a delta and checks everything that doesn't need the base rows. */
export function decodeDirectoryDelta(
  text: string,
): Result<DirectoryDelta, string> {
  const split = lines(text);
  if (!split.ok) return split;
  const [signature, headerLine, targetHeaderLine, ...body] = split.value;
  if (
    signature !== deltaSignature ||
    headerLine === undefined ||
    targetHeaderLine === undefined ||
    split.value.length < leadingLines
  )
    return failure("Unsupported directory delta format");
  const headerJson = parseJson(headerLine);
  if (!headerJson.ok) return headerJson;
  const header = v.safeParse(DirectoryDeltaHeaderSchema, headerJson.value);
  if (!header.success) return failure("The directory delta header is invalid");
  const targetJson = parseJson(targetHeaderLine);
  if (!targetJson.ok) return targetJson;
  const targetHeader = v.safeParse(
    DirectoryArchiveHeaderSchema,
    targetJson.value,
  );
  if (
    !targetHeader.success ||
    targetHeader.output.snapshot !== header.output.target.snapshot ||
    targetHeader.output.contacts !== header.output.target.contacts ||
    !mapsFit(header.output, targetHeader.output)
  )
    return failure("The directory delta target header differs");
  const instructions: DirectoryDeltaInstruction[] = [];
  const copies: { start: number; count: number }[] = [];
  let added = 0;
  for (const line of body) {
    const instruction = decodeInstruction(line);
    if (!instruction)
      return failure("A directory delta instruction is invalid");
    instructions.push(instruction);
    if (instruction.kind === "add") added += 1;
    else if (
      copyAdmission(
        instruction.start,
        instruction.count,
        header.output.base.contacts,
      )
    )
      copies.push(instruction);
    else return failure("A directory delta copy leaves the base");
  }
  copies.sort((left, right) => left.start - right.start);
  let kept = 0;
  let end = 0;
  for (const copy of copies) {
    if (copy.start < end) return failure("Directory delta copies overlap");
    end = copy.start + copy.count;
    kept += copy.count;
  }
  if (kept !== header.output.kept || added !== header.output.added)
    return failure("The directory delta counts differ from its instructions");
  return {
    ok: true,
    value: {
      header: header.output,
      targetHeaderLine,
      targetHeader: targetHeader.output,
      instructions,
    },
  };
}

function digestText(
  text: string,
  digest: () => DeltaDigest,
): {
  readonly sha256: string;
  readonly bytes: number;
} {
  const hasher = digest();
  const bytes = new TextEncoder().encode(text);
  hasher.update(bytes);
  return { sha256: hasher.digest(), bytes: bytes.byteLength };
}

function baseMatches(
  header: DirectoryDeltaHeader,
  base: DirectoryText,
  identity: { readonly sha256: string; readonly bytes: number },
): boolean {
  return (
    header.base.snapshot === base.header.snapshot &&
    header.base.contacts === base.rows.length &&
    header.base.sha256 === identity.sha256 &&
    header.base.bytes === identity.bytes &&
    header.categories.length === base.header.categories.length &&
    header.provenances.length === base.header.provenances.length &&
    header.links.length === base.header.links.length
  );
}

/**
 * Applies a delta in target order, hashing each line as it is written, and admits the result only when the base, the instructions, the row count, the length, and the SHA-256 all match.
 */
export function applyDirectoryDelta(
  baseText: string,
  deltaText: string,
  digest: () => DeltaDigest,
): AppliedDirectoryDelta {
  const rejected = (admission: DeltaAdmission): AppliedDirectoryDelta => ({
    admission,
    text: null,
  });
  const delta = decodeDirectoryDelta(deltaText);
  const base = readDirectoryText(baseText);
  if (!delta.ok)
    return rejected(deltaAdmission(base.ok, false, 0, 0, 0, 0, false));
  const { header } = delta.value;
  if (
    !base.ok ||
    !baseMatches(header, base.value, digestText(baseText, digest))
  )
    return rejected(deltaAdmission(false, true, 0, 0, 0, 0, false));
  const target = sizes(delta.value.targetHeader);
  const encoder = new TextEncoder();
  const hasher = digest();
  const parts: string[] = [];
  let bytes = 0;
  let rows = 0;
  const write = (line: string): void => {
    const chunk = `${line}${lineTerminator}`;
    const encoded = encoder.encode(chunk);
    hasher.update(encoded);
    bytes += encoded.byteLength;
    parts.push(chunk);
  };
  write(archiveSignature);
  write(delta.value.targetHeaderLine);
  let wellFormed = true;
  for (const instruction of delta.value.instructions) {
    if (instruction.kind === "add") {
      write(instruction.row);
      rows += 1;
      continue;
    }
    for (
      let position = instruction.start;
      position < instruction.start + instruction.count;
      position += 1
    ) {
      const row = base.value.rows[position];
      const mapped = row === undefined ? null : remapRow(row, header, target);
      if (mapped === null) {
        wellFormed = false;
        break;
      }
      write(mapped);
      rows += 1;
    }
    if (!wellFormed) break;
  }
  const admission = deltaAdmission(
    true,
    wellFormed,
    rows,
    header.target.contacts,
    bytes,
    header.target.bytes,
    hasher.digest() === header.target.sha256,
  );
  return admission === "apply"
    ? { admission, text: parts.join("") }
    : rejected(admission);
}

/**
 * Checks a delta's target side without its base: the target identity and header line, every literal row at its target position, and the total row count.
 */
export function deltaMatchesTarget(
  delta: DirectoryDelta,
  target: DirectoryText,
  identity: Omit<DirectoryArchiveIdentity, "contacts">,
): boolean {
  const { header } = delta;
  if (
    header.target.snapshot !== identity.snapshot ||
    header.target.archiveSha256 !== identity.archiveSha256 ||
    header.target.sha256 !== identity.sha256 ||
    header.target.bytes !== identity.bytes ||
    header.target.contacts !== target.rows.length ||
    delta.targetHeaderLine !== target.headerLine
  )
    return false;
  let position = 0;
  for (const instruction of delta.instructions) {
    if (instruction.kind === "copy") {
      position += instruction.count;
      continue;
    }
    if (target.rows[position] !== instruction.row) return false;
    position += 1;
  }
  return position === target.rows.length;
}
