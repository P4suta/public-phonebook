import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { Result } from "./result.ts";

const maximumSourcePhoneLength = 80;
const countryDialingPrefix = "+81";

export function normalizePhone(input: string): Result<string, "invalid_phone"> {
  const text = input.trim();
  if (
    text.length > maximumSourcePhoneLength ||
    !/^[0-9０-９+＋()（）.． \t\u00a0\u3000\-－‐‑‒–—―−⁻₋﹣ーｰ]+$/u.test(text)
  )
    return { ok: false, error: "invalid_phone" };
  const normalized = text.normalize("NFKC");
  const compact = normalized.replace(/[ \t().\-‐‑‒–—―−ー]/gu, "");
  const domestic = compact.startsWith(countryDialingPrefix)
    ? `0${compact.slice(countryDialingPrefix.length)}`
    : compact;
  if (!/^0[1-9][0-9]{8,9}$/.test(domestic))
    return { ok: false, error: "invalid_phone" };
  return { ok: true, value: `+81${domestic.slice(1)}` };
}

export function formatPhone(e164: string): string {
  const canonical = normalizePhone(e164);
  if (!canonical.ok || canonical.value !== e164) return e164;
  const phone = parsePhoneNumberFromString(e164, { extract: false });
  const formatted = phone?.formatNational();
  if (formatted) {
    const roundtrip = normalizePhone(formatted);
    if (roundtrip.ok && roundtrip.value === e164) return formatted;
  }
  return `0${e164.slice(countryDialingPrefix.length)}`;
}
