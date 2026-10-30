import postcss from "postcss";
import { expect, it } from "vitest";
import { referenceStyles } from "../../tools/reference-styles.ts";

it("keeps Scalar layout while replacing its presentation through the shared design theme", async () => {
  const result = await postcss([referenceStyles()]).process(
    ".control { color: red; background: linear-gradient(black, white); border: 1px solid gray; opacity: .5; box-shadow: 1px 1px black; filter: blur(1px); mask-image: linear-gradient(black, transparent); fill-opacity: .5; stroke-opacity: .5; padding: 12px; display: flex; }",
    { from: "/project/node_modules/@scalar/api-reference/dist/style.css" },
  );
  expect(result.css).toContain("padding: 12px");
  expect(result.css).toContain("display: flex");
  for (const property of [
    "color:",
    "background:",
    "border:",
    "opacity:",
    "shadow:",
    "filter:",
    "mask-image:",
    "fill-opacity:",
    "stroke-opacity:",
  ])
    expect(result.css).not.toContain(property);
});

it("does not hide prohibited styling in application files or unrelated dependencies", async () => {
  const css = ".control { color: red; opacity: .5; }";
  for (const from of [
    "/project/src/ui/styles.css",
    "/project/node_modules/@scalar-lookalike/style.css",
  ]) {
    expect(
      (await postcss([referenceStyles()]).process(css, { from })).css,
    ).toBe(css);
  }
});

it("preserves binary paints and visibility so checked controls keep their state", async () => {
  const css =
    ".checked { background-color: var(--scalar-color-accent); color: var(--scalar-background-1); opacity: 1; } .hidden { opacity: 0; } .paper { color: #fff; background: black; }";
  expect(
    (
      await postcss([referenceStyles()]).process(css, {
        from: "/project/node_modules/@scalar/components/dist/style.css",
      })
    ).css,
  ).toBe(css);
});
