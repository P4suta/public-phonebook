import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { PhoneSchema } from "../../src/core/models.ts";
import { formatPhone, normalizePhone } from "../../src/core/phone.ts";

describe("Japanese directory telephone numbers", () => {
  it.each([
    "088-844-0111",
    "０８８－８４４－０１１１",
    "088−844−0111",
    "088―844―0111",
    "088⁻844⁻0111",
    "088₋844₋0111",
    "088‐844‐0111",
    "088ｰ844ｰ0111",
    "088(844)0111",
    "(088)844-0111",
    "088)844-0111",
    "0888440111",
    "088 844 0111",
    "+81 88 844 0111",
    "＋８１（８８）８４４－０１１１",
  ])("normalizes %s without changing its digits", (input: string) => {
    expect(normalizePhone(input)).toEqual({ ok: true, value: "+81888440111" });
  });
  it.each([
    "03-3581-2331 / 03-3581-2332",
    "03\n35812331",
    "03-3581-2331 内線123",
    "FAX:03-3581-2331",
    "tel:03-3581-2331;ext=1",
    "03-3581-2331,03-3581-2332",
    "③-3581-2331",
    "⓪③-3581-2331",
    "+1 213 373 4253",
    "+81 0 88 844 0111",
    "110",
    "",
  ])("rejects ambiguous or out-of-scope input %s", (input: string) => {
    expect(normalizePhone(input)).toEqual({
      ok: false,
      error: "invalid_phone",
    });
  });
  it.each([
    ["+81888440111", "088-844-0111"],
    ["+81335812331", "03-3581-2331"],
    ["+81456450567", "045-645-0567"],
    ["+81996921111", "09969-2-1111"],
    ["+81229432113", "0229-43-2113"],
    ["+819012345678", "090-1234-5678"],
    ["+81120123456", "0120-123-456"],
    ["+818001112222", "0800-111-2222"],
    ["+81570000911", "0570-000-911"],
  ])(
    "formats %s using Japanese numbering metadata",
    (e164: string, display: string) => {
      expect(formatPhone(e164)).toBe(display);
      expect(normalizePhone(display)).toEqual({ ok: true, value: e164 });
    },
  );
  it("rejects source spellings that disagree with their dial destination", () => {
    expect(
      v.safeParse(PhoneSchema, {
        display: "088－844－0111",
        e164: "+81888440111",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(PhoneSchema, {
        display: "088－844－0112",
        e164: "+81888440111",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PhoneSchema, {
        display: "03-3581-2331 内線123",
        e164: "+81335812331",
      }).success,
    ).toBe(false);
  });
  it("preserves admitted digits through formatting and repeated normalization", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.array(fc.integer({ min: 0, max: 9 }), {
          minLength: 8,
          maxLength: 9,
        }),
        (first: number, rest: number[]) => {
          const e164 = `+81${first}${rest.join("")}`;
          const normalized = normalizePhone(formatPhone(e164));
          expect(normalized).toEqual({ ok: true, value: e164 });
          if (normalized.ok)
            expect(normalizePhone(normalized.value)).toEqual(normalized);
        },
      ),
      { seed: 88440111, numRuns: 2000 },
    );
  });
});
