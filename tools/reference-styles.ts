import type { Plugin } from "postcss";
import { stripReferenceStyle } from "../src/core/reference-style-policy.ts";

export function referenceStyles(): Plugin {
  return {
    postcssPlugin: "dial-monochrome-reference",
    Declaration(declaration): void {
      const source =
        declaration.source?.input.file?.replaceAll("\\", "/") ?? "";
      if (
        !source.includes("/node_modules/@scalar/") ||
        !stripReferenceStyle(declaration.prop.toLowerCase())
      )
        return;
      const value = declaration.value.trim().toLowerCase();
      const effect = [
        "box-shadow",
        "text-shadow",
        "filter",
        "backdrop-filter",
        "background-image",
        "mask",
        "mask-image",
        "-webkit-mask",
        "-webkit-mask-image",
        "mix-blend-mode",
        "animation",
        "animation-name",
        "transition",
      ].includes(declaration.prop.toLowerCase());
      if (
        [
          "black",
          "white",
          "transparent",
          "currentcolor",
          "none",
          "inherit",
          "initial",
          "unset",
          "#000",
          "#000000",
          "#fff",
          "#ffffff",
          "0",
          "1",
        ].includes(value) ||
        (!effect && /^var\(--scalar-[a-z0-9-]+\)$/u.test(value))
      )
        return;
      declaration.remove();
    },
  };
}
