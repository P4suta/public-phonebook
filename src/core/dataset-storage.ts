import * as v from "valibot";
import { DigestSchema } from "./models.ts";

export function manifestObjectKey(
  snapshot: string,
  manifestSha256?: string,
): string {
  const checkedSnapshot = v.parse(DigestSchema, snapshot);
  return manifestSha256 === undefined
    ? `${checkedSnapshot}/manifest.json`
    : `${checkedSnapshot}/${v.parse(DigestSchema, manifestSha256)}/manifest.json`;
}
