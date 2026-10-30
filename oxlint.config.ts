import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["src/routeTree.gen.ts"],
  plugins: ["typescript", "react", "jsx-a11y", "import"],
  options: { typeAware: true },
  categories: { correctness: "error" },
  rules: {
    "typescript/no-explicit-any": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/explicit-function-return-type": [
      "error",
      { allowTypedFunctionExpressions: true, allowHigherOrderFunctions: true },
    ],
    "typescript/consistent-type-assertions": [
      "error",
      { assertionStyle: "never" },
    ],
  },
});
