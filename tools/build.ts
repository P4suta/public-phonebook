import { createBuilder } from "vite";
import { deploymentEnvironment } from "../src/core/environment.ts";

const [mode = "development"] = process.argv.slice(2);
const builder = await createBuilder({ mode: deploymentEnvironment(mode) });
await builder.buildApp();
