import * as v from "valibot";

const hexadecimalRadix = 16;
const hexadecimalByteWidth = 2;
const maximumIdentifierLength = 512;
const maximumSortableNameBytes = 384;

export function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim();
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(hexadecimalRadix).padStart(hexadecimalByteWidth, "0"),
  ).join("");
}

export const IdentifierSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.regex(/^[A-Za-z0-9:._-]+$/),
);
export const SortableNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(maximumIdentifierLength),
  v.check((name) => {
    const normalized = normalizeName(name);
    return (
      normalized.length > 0 &&
      new TextEncoder().encode(normalized).length <= maximumSortableNameBytes
    );
  }),
);
