import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { expect, it } from "vitest";
import { databaseResourceName } from "../../src/core/environment.ts";
import {
  importDecision,
  promotionAdmission,
  withdrawalDecision,
} from "../../src/core/publication-policy.ts";
import type { SqlPort } from "../../tools/remote-statements.ts";
import { insertStatements } from "../../tools/remote-statements.ts";
import { checkImportIdentity, copyStage } from "../../tools/seed-database.ts";

it("isolates remote database publications and rejects unbound deployment identities", () => {
  const identity = "a".repeat(64);
  expect(databaseResourceName("development")).toBe(
    "dial-development-directory",
  );
  expect(databaseResourceName("production", identity)).toBe(
    `dial-production-directory-${"a".repeat(32)}`,
  );
  expect(databaseResourceName("production", identity)).not.toBe(
    databaseResourceName("production", "b".repeat(64)),
  );
  expect(() => databaseResourceName("production")).toThrow();
  expect(() => databaseResourceName("production", "../../unbound")).toThrow();
});

it("starts only an empty import and resumes only the same publication", () => {
  expect(importDecision("", "publication")).toBe("start");
  expect(importDecision("publication", "publication")).toBe("resume");
  expect(importDecision("different", "publication")).toBe("conflict");
});

it("promotes only the verified candidate that is still deployed beside the unchanged current version", () => {
  expect(
    promotionAdmission(true, "candidate", true, "candidate", "prior", "prior"),
  ).toBe("promote");
  expect(
    promotionAdmission(false, "candidate", true, "candidate", "prior", "prior"),
  ).toBe("unverified");
  expect(
    promotionAdmission(true, "candidate", true, "candidate", "prior", "other"),
  ).toBe("current-changed");
  expect(
    promotionAdmission(true, "candidate", false, "", "prior", "prior"),
  ).toBe("candidate-missing");
  expect(
    promotionAdmission(true, "candidate", true, "other", "prior", "prior"),
  ).toBe("different-version");
});

it("withdraws only an owned candidate that never took traffic while the predecessor serves", () => {
  for (const beforeTraffic of [false, true])
    for (const currentIsPrevious of [false, true])
      for (const present of [false, true])
        for (const owned of [false, true]) {
          const decision = withdrawalDecision(
            beforeTraffic,
            currentIsPrevious,
            present,
            owned,
          );
          const expected =
            !beforeTraffic || !currentIsPrevious
              ? "refuse"
              : !present
                ? "already-withdrawn"
                : owned
                  ? "remove-candidate"
                  : "refuse";
          expect(
            decision,
            JSON.stringify({
              beforeTraffic,
              currentIsPrevious,
              present,
              owned,
            }),
          ).toBe(expected);
        }
});

it("binds values without changing quotes, newlines, Unicode, empty text, or null", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT)");
    const rows = [
      ["quote'\"; DROP TABLE sources; --", "東京都\n施設"],
      ["empty", ""],
      ["missing", null],
    ];
    for (const statement of insertStatements("sources", rows))
      db.prepare(statement.sql).run(...statement.params);
    expect(
      db
        .prepare("SELECT id,payload FROM sources ORDER BY rowid")
        .all()
        .map((row) => [row.id, row.payload]),
    ).toEqual(rows);
  } finally {
    db.close();
  }
});

it("partitions every input row within D1's 100-parameter statement limit", () => {
  const rows = Array.from({ length: 127 }, (_, index) => [
    String(index),
    `value:${index}`,
  ]);
  const statements = [...insertStatements("sources", rows)];
  expect(statements.length).toBeGreaterThan(1);
  expect(statements.flatMap((statement) => statement.params)).toEqual(
    rows.flat(),
  );
  expect(statements.every((statement) => statement.params.length <= 100)).toBe(
    true,
  );
  expect(() => [...insertStatements("sources", [["missing value"]])]).toThrow();
  expect([...insertStatements("sources", [])]).toEqual([]);
});

it("resumes after an acknowledged-lost native D1 commit and rolls back failed batches", async () => {
  const runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    unsafeEnableSharedStorage: false,
    workers: [
      {
        config: {
          name: "import-fixture",
          compatibilityDate: "2026-10-29",
          manifest: {
            mainModule: "fixture.js",
            modules: {
              "fixture.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response('fixture'); } }",
              },
            },
          },
          env: { DB: { type: "d1", id: "import-fixture" } },
        },
      },
    ],
  });
  const source = new DatabaseSync(":memory:");
  try {
    source.exec("CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT)");
    for (let index = 0; index < 113; index += 1)
      source
        .prepare("INSERT INTO sources VALUES (?,?)")
        .run(String(index).padStart(3, "0"), `quote'\n施設:${index}`);
    const db = await runtime.getD1Database("DB");
    const port: SqlPort = {
      async execute(statements) {
        const results = await db.batch(
          statements.map((statement) =>
            db.prepare(statement.sql).bind(...statement.params),
          ),
        );
        return v.parse(
          v.array(v.record(v.string(), v.unknown())),
          results.flatMap((result) => result.results),
        );
      },
    };
    expect(await checkImportIdentity(port, "identity")).toBe("start");
    await db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT)");
    await expect(checkImportIdentity(port, "identity")).rejects.toThrow(
      "unowned",
    );
    await db.exec(
      "CREATE TABLE __dial_import(stage TEXT PRIMARY KEY,snapshot TEXT,completed INTEGER); INSERT INTO __dial_import VALUES ('sources','identity',0)",
    );
    expect(await checkImportIdentity(port, "identity")).toBe("resume");
    await expect(checkImportIdentity(port, "different")).rejects.toThrow(
      "different publication",
    );
    const lost: SqlPort = {
      async execute(statements) {
        await port.execute(statements);
        throw new Error("The response was lost after commit");
      },
    };
    await expect(
      copyStage(lost, source, "sources", 0, "identity", { batchStatements: 1 }),
    ).rejects.toThrow("after commit");
    const progress = await db
      .prepare("SELECT completed FROM __dial_import")
      .first<number>("completed");
    expect(progress).toBe(50);
    if (progress === null) throw new Error("Missing checkpoint");
    expect(
      await copyStage(port, source, "sources", progress, "identity", {
        batchStatements: 1,
      }),
    ).toBe(113);
    const actual = await db
      .prepare("SELECT id,payload FROM sources ORDER BY id")
      .all();
    expect(actual.results).toEqual(
      source.prepare("SELECT id,payload FROM sources ORDER BY id").all(),
    );
    await expect(
      port.execute([
        {
          sql: "INSERT INTO sources VALUES (?,?)",
          params: ["uncommitted", "value"],
        },
        {
          sql: "INSERT INTO sources VALUES (?,?)",
          params: ["000", "duplicate"],
        },
        { sql: "UPDATE __dial_import SET completed=999", params: [] },
      ]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM sources WHERE id='uncommitted'")
        .first("count"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT completed FROM __dial_import")
        .first("completed"),
    ).toBe(113);
  } finally {
    source.close();
    await runtime.dispose();
  }
});
