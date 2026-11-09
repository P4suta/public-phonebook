import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { expect, it } from "vitest";
import { parse } from "yaml";

const denied =
  "This token does not have access to requested config 'ci_production'";

async function refusal(status: number, body: string): Promise<number | null> {
  const workflow: unknown = parse(
    await readFile(".github/workflows/pipeline-controls.yml", "utf8"),
  );
  const document = v.parse(
    v.object({
      jobs: v.object({
        "foreign-secret": v.object({
          steps: v.array(v.object({ run: v.string() })),
        }),
      }),
    }),
    workflow,
  );
  const run = document.jobs["foreign-secret"].steps.at(-1)?.run;
  if (!run) throw new Error("The foreign-config check is missing");
  const start = run.indexOf('if [ "$status" = 200 ]; then');
  if (start < 0) throw new Error("The response admission boundary is missing");
  const directory = await mkdtemp(join(tmpdir(), "phonebook-refusal-"));
  const file = join(directory, "response.json");
  try {
    await writeFile(file, body);
    const result = spawnSync(
      "bash",
      ["-euo", "pipefail", "-c", run.slice(start)],
      {
        env: { ...process.env, status: String(status), body: file },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65_536,
      },
    );
    if (result.error) throw result.error;
    return result.status;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("accepts the observed Doppler config refusal and an HTTP permission refusal", async () => {
  expect(await refusal(400, JSON.stringify({ messages: [denied] }))).toBe(0);
  expect(
    await refusal(403, JSON.stringify({ messages: ["Access denied"] })),
  ).toBe(0);
});

it("rejects success, unrelated failures, another config, and malformed responses", async () => {
  for (const status of [200, 401, 404, 500])
    expect(
      await refusal(status, JSON.stringify({ messages: [denied] })),
    ).not.toBe(0);
  for (const body of [
    JSON.stringify({ messages: ["Invalid request"] }),
    JSON.stringify({ messages: [denied.replace("ci_production", "another")] }),
    JSON.stringify({ messages: [] }),
    "invalid JSON",
  ])
    expect(await refusal(400, body)).not.toBe(0);
});
