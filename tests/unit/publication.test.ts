import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  importIdentity,
  importTransformation,
} from "@public-phonebook/cloudflare/import-identity";
import type { SqlPort } from "@public-phonebook/cloudflare/remote-statements";
import { insertStatements } from "@public-phonebook/cloudflare/remote-statements";
import {
  checkImportIdentity,
  copyStage,
  seedDatabase,
  type VerificationFacts,
} from "@public-phonebook/cloudflare/seed-database";
import { PreparedDatasetManifestSchema } from "@public-phonebook/directory/dataset-storage";
import { databaseResourceName } from "@public-phonebook/directory/environment";
import type { DatasetManifest } from "@public-phonebook/directory/models";
import {
  type DatabaseVerification,
  databaseVerification,
  importDecision,
  promotionAdmission,
  targetBinding,
  withdrawalDecision,
} from "@public-phonebook/directory/publication-policy";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeCheckFixture } from "../../tools/check-fixture.ts";

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

it("binds exactly the database that a target holds by ID and vouches only for one it staged for the same dataset", () => {
  for (const sameDatabase of [false, true])
    for (const sameDataset of [false, true])
      for (const prepared of [false, true])
        for (const digestBound of [false, true]) {
          const label = JSON.stringify({
            sameDatabase,
            sameDataset,
            prepared,
            digestBound,
          });
          const binding = targetBinding(
            sameDatabase,
            sameDataset,
            prepared,
            digestBound,
          );
          expect(binding === "unrelated", label).toBe(!sameDatabase);
          expect(binding === "vouches", label).toBe(
            sameDatabase && sameDataset && prepared && digestBound,
          );
        }
});

describe("database verification decision", () => {
  const cases = [false, true].flatMap((evidencePresent) =>
    [false, true].flatMap((digestMatches) =>
      [false, true].flatMap((resourceMatches) =>
        [false, true].flatMap((complete) =>
          [false, true].flatMap((bound) =>
            [false, true].map((publicationVerified) => ({
              evidencePresent,
              digestMatches,
              resourceMatches,
              complete,
              bound,
              publicationVerified,
            })),
          ),
        ),
      ),
    ),
  );
  const decide = (input: (typeof cases)[number]): DatabaseVerification =>
    databaseVerification(
      input.evidencePresent,
      input.digestMatches ? "database" : "other-database",
      "database",
      input.resourceMatches ? "resource" : "other-resource",
      "resource",
      input.complete,
      input.bound,
      input.publicationVerified,
    );

  it("scans in full exactly the databases that have no evidence and no binding", () => {
    expect(cases).toHaveLength(64);
    for (const input of cases)
      expect(decide(input) === "verify", JSON.stringify(input)).toBe(
        !input.evidencePresent && !input.bound,
      );
  });

  it("never scans a bound database in full, with or without a verified publication", () => {
    for (const input of cases.filter((item) => item.bound))
      expect(decide(input), JSON.stringify(input)).not.toBe("verify");
    for (const publicationVerified of [false, true])
      expect(
        databaseVerification(
          false,
          "",
          "database",
          "",
          "resource",
          true,
          true,
          publicationVerified,
        ),
      ).not.toBe("verify");
  });

  it("refuses evidence for another digest or resource whatever else holds", () => {
    for (const input of cases.filter(
      (item) =>
        item.evidencePresent && !(item.digestMatches && item.resourceMatches),
    ))
      expect(decide(input), JSON.stringify(input)).toBe("foreign-evidence");
  });

  it("accepts only a complete database, through matching evidence or a verified publication that binds it", () => {
    for (const input of cases) {
      const result = decide(input);
      const label = JSON.stringify(input);
      expect(result === "accept-evidence", label).toBe(
        input.evidencePresent &&
          input.digestMatches &&
          input.resourceMatches &&
          input.complete,
      );
      expect(result === "accept-publication", label).toBe(
        !input.evidencePresent &&
          input.bound &&
          input.complete &&
          input.publicationVerified,
      );
    }
  });

  it("names a refusal for a changed database and for a binding without verification", () => {
    for (const input of cases) {
      const result = decide(input);
      const label = JSON.stringify(input);
      const evidenceMatches =
        input.evidencePresent && input.digestMatches && input.resourceMatches;
      expect(result === "incomplete-database", label).toBe(
        !input.complete &&
          (evidenceMatches || (!input.evidencePresent && input.bound)),
      );
      expect(result === "unverified-binding", label).toBe(
        !input.evidencePresent &&
          input.bound &&
          input.complete &&
          !input.publicationVerified,
      );
    }
  });
});

/** A local SQLite database that applies each batch atomically, as D1 does, and records every statement it receives. */
function localDatabase(): {
  readonly port: SqlPort;
  readonly statements: string[];
  readonly close: () => void;
} {
  const database = new DatabaseSync(":memory:");
  const statements: string[] = [];
  return {
    statements,
    close: () => database.close(),
    port: {
      async execute(batch) {
        statements.push(...batch.map((statement) => statement.sql));
        database.exec("BEGIN");
        try {
          const rows = batch.flatMap((statement) =>
            database.prepare(statement.sql).all(...statement.params),
          );
          database.exec("COMMIT");
          return rows;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

const fullScan = /count\(|foreign_key_check/iu;
const write = /^\s*(?:insert|create|update|delete|drop|alter)\b/iu;

describe("database verification during preparation", () => {
  const resource = "0f6a8c1e-2b3d-4e5f-8a9b-1c2d3e4f5a6b";
  let root = "";
  let path = "";
  let manifest: DatasetManifest;
  let identity = "";
  let evidence: VerificationFacts["evidence"];
  const unbound = (): VerificationFacts => ({
    importSha256: identity,
    resource,
    evidence: null,
    bound: false,
    publicationVerified: false,
  });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "phonebook-seed-"));
    await writeCheckFixture(join(root, "bundle"));
    path = join(root, "bundle", "directory.sqlite");
    manifest = v.parse(
      PreparedDatasetManifestSchema,
      JSON.parse(
        await readFile(join(root, "bundle", "manifest.ready.json"), "utf8"),
      ),
    );
    identity = importIdentity(manifest.databaseSha256).importSha256;
    evidence = { importSha256: identity, database: resource };
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function imported(): Promise<ReturnType<typeof localDatabase>> {
    const remote = localDatabase();
    const fresh = await seedDatabase(remote.port, path, manifest, unbound());
    expect(fresh.verification).toBe("verify");
    remote.statements.length = 0;
    return remote;
  }

  it("imports a fresh unbound database and scans it in full once", async () => {
    const remote = localDatabase();
    try {
      const fresh = await seedDatabase(remote.port, path, manifest, unbound());
      if (fresh.verification !== "verify") throw new Error("Not verified");
      expect(fresh.counts.contacts).toBe(manifest.contacts);
      expect(fresh.counts.indexed).toBe(manifest.contacts);
      expect(remote.statements.filter((sql) => fullScan.test(sql))).toEqual([
        expect.stringContaining("count(DISTINCT number)"),
        "PRAGMA foreign_key_check",
      ]);
      expect(remote.statements.some((sql) => write.test(sql))).toBe(true);
    } finally {
      remote.close();
    }
  });

  it("accepts evidence or the verified publication of a bound database with cheap reads alone", async () => {
    const remote = await imported();
    try {
      for (const [facts, verification] of [
        [{ ...unbound(), evidence, bound: true }, "accept-evidence"],
        [{ ...unbound(), evidence }, "accept-evidence"],
        [
          { ...unbound(), bound: true, publicationVerified: true },
          "accept-publication",
        ],
      ] as const) {
        expect(await seedDatabase(remote.port, path, manifest, facts)).toEqual({
          verification,
        });
        expect(
          remote.statements.filter(
            (sql) => fullScan.test(sql) || write.test(sql),
          ),
          verification,
        ).toEqual([]);
        remote.statements.length = 0;
      }
    } finally {
      remote.close();
    }
  });

  it("refuses a bound database without evidence before any full scan or write", async () => {
    const remote = await imported();
    try {
      await expect(
        seedDatabase(remote.port, path, manifest, {
          ...unbound(),
          bound: true,
        }),
      ).rejects.toThrow("no evidence of its full verification");
      expect(
        remote.statements.filter(
          (sql) => fullScan.test(sql) || write.test(sql),
        ),
      ).toEqual([]);
    } finally {
      remote.close();
    }
  });

  it("refuses evidence for another import identity or resource before any full scan or write", async () => {
    for (const foreign of [
      { importSha256: "f".repeat(64), database: resource },
      { importSha256: manifest.databaseSha256, database: resource },
      {
        importSha256: identity,
        database: "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",
      },
    ]) {
      for (const remote of [localDatabase(), await imported()])
        try {
          await expect(
            seedDatabase(remote.port, path, manifest, {
              ...unbound(),
              evidence: foreign,
            }),
          ).rejects.toThrow("names another database");
          expect(
            remote.statements.filter(
              (sql) => fullScan.test(sql) || write.test(sql),
            ),
          ).toEqual([]);
        } finally {
          remote.close();
        }
    }
  });

  it("refuses to import into a bound or evidenced database that isn't complete", async () => {
    for (const facts of [
      { ...unbound(), bound: true, publicationVerified: true },
      { ...unbound(), evidence },
    ]) {
      const remote = localDatabase();
      try {
        await expect(
          seedDatabase(remote.port, path, manifest, facts),
        ).rejects.toThrow("Refusing to import");
        expect(remote.statements.some((sql) => write.test(sql))).toBe(false);
      } finally {
        remote.close();
      }
    }
  });

  it("scans an unbound complete database without evidence again, as after an interrupted verification", async () => {
    const remote = await imported();
    try {
      const again = await seedDatabase(remote.port, path, manifest, unbound());
      expect(again.verification).toBe("verify");
      expect(
        remote.statements.filter((sql) => fullScan.test(sql)),
      ).toHaveLength(2);
      expect(remote.statements.some((sql) => write.test(sql))).toBe(false);
    } finally {
      remote.close();
    }
  });

  it("refuses a database of the same dataset that an earlier import identity filled before any full scan or write", async () => {
    const earlier = {
      "the bare dataset digest": manifest.databaseSha256,
      "the schema without folded names": importIdentity(
        manifest.databaseSha256,
        {
          ...importTransformation,
          schema: importTransformation.schema.replace(
            "  folded_name TEXT NOT NULL,\n",
            "",
          ),
        },
      ).importSha256,
      "a smaller fold table": importIdentity(manifest.databaseSha256, {
        ...importTransformation,
        folds: importTransformation.folds.slice(1),
      }).importSha256,
    };
    for (const [label, importSha256] of Object.entries(earlier)) {
      expect(importSha256, label).not.toBe(identity);
      const remote = localDatabase();
      try {
        expect(
          (
            await seedDatabase(remote.port, path, manifest, {
              ...unbound(),
              importSha256,
            })
          ).verification,
          label,
        ).toBe("verify");
        remote.statements.length = 0;
        await expect(
          seedDatabase(remote.port, path, manifest, unbound()),
          label,
        ).rejects.toThrow("different publication");
        await expect(
          seedDatabase(remote.port, path, manifest, {
            ...unbound(),
            bound: true,
            publicationVerified: true,
          }),
          label,
        ).rejects.toThrow("different publication");
        expect(
          remote.statements.filter(
            (sql) => fullScan.test(sql) || write.test(sql),
          ),
          label,
        ).toEqual([]);
      } finally {
        remote.close();
      }
    }
  });
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
