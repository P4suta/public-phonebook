import {
  admitFileSearch,
  type FileSearch,
  type SearchFiles,
  writeSearchFile,
} from "@public-phonebook/directory/file-search";
import {
  type LocalSearchReply,
  LocalSearchRequestSchema,
} from "@public-phonebook/directory/local-search-protocol";
import * as v from "valibot";
import { downloadSearchFile } from "./search-download.ts";

export interface TemporarySearchFiles extends SearchFiles {
  dispose(): Promise<void>;
}

interface FileSearchPorts {
  readonly files: () => Promise<TemporarySearchFiles>;
  readonly fetch: (url: string) => Promise<Response>;
  readonly post: (reply: LocalSearchReply) => void;
  readonly yield: () => Promise<void>;
}

export function fileSearchService(
  ports: FileSearchPorts,
): (message: unknown) => Promise<void> {
  let generation = 0;
  let active: {
    readonly index: FileSearch;
    readonly files: TemporarySearchFiles;
  } | null = null;

  async function retire(
    files: TemporarySearchFiles | null | undefined,
  ): Promise<void> {
    try {
      await files?.dispose();
    } catch {
      /* Inactive public files are retried by startup cleanup. */
    }
  }

  async function discard(): Promise<void> {
    const previous = active;
    active = null;
    await retire(previous?.files);
  }

  return async (message) => {
    const request = v.parse(LocalSearchRequestSchema, message);
    if (request.type === "load-forgiving") {
      ports.post({
        type: "unavailable",
        reason: "malformed",
        detail: "Forgiving search is unavailable",
      });
      return;
    }
    if (request.type === "load") {
      const load = ++generation;
      const current = (): boolean => load === generation;
      let candidate: TemporarySearchFiles | null = null;
      try {
        candidate = await ports.files();
        const raw = candidate.raw;
        const downloaded = await downloadSearchFile(
          ports,
          request.index,
          current,
          (bytes, at) => writeSearchFile(raw, bytes, at),
        );
        if (!current()) return;
        if (!downloaded.ok) {
          await discard();
          if (current())
            ports.post({ type: "unavailable", ...downloaded.error });
          return;
        }
        const index = await admitFileSearch(candidate, async () => {
          await ports.yield();
          if (!current()) throw new Error("The index load was superseded");
        });
        if (!current()) return;
        if (index.header.snapshot !== request.index.snapshot) {
          await discard();
          if (!current()) return;
          ports.post({
            type: "unavailable",
            reason: "snapshot_mismatch",
            detail: "",
          });
          return;
        }
        const previous = active;
        active = { index, files: candidate };
        candidate = null;
        const { snapshot, contacts, categories, prefectures, municipalities } =
          index.header;
        ports.post({
          type: "ready",
          snapshot,
          contacts,
          categories,
          prefectures,
          municipalities,
        });
        await retire(previous?.files);
      } catch (error) {
        if (current()) {
          await discard();
          if (!current()) return;
          ports.post({
            type: "unavailable",
            reason: "malformed",
            detail: String(error),
          });
        }
      } finally {
        await retire(candidate);
      }
      return;
    }
    const current = active;
    const queryGeneration = generation;
    if (!current) {
      ports.post({ type: "failed", id: request.id, error: "not_ready" });
      return;
    }
    try {
      if (request.type === "search") {
        const result = current.index.search(request.query);
        if (!result.ok) {
          ports.post({ type: "failed", id: request.id, error: result.error });
          return;
        }
        ports.post({
          type: "results",
          id: request.id,
          total: result.value.total,
          groups: result.value.groups.map((group) => ({
            ...group,
            rows: group.rows.map((row) => current.index.row(row)),
          })),
        });
      } else {
        const result = current.index.continue(
          request.query,
          request.category,
          request.visible,
        );
        if (!result.ok) {
          ports.post({ type: "failed", id: request.id, error: result.error });
          return;
        }
        ports.post({
          type: "page",
          id: request.id,
          ...result.value,
          rows: result.value.rows.map((row) => current.index.row(row)),
        });
      }
    } catch (error) {
      await discard();
      ports.post({ type: "failed", id: request.id, error: "not_ready" });
      if (queryGeneration === generation)
        ports.post({
          type: "unavailable",
          reason: "malformed",
          detail: String(error),
        });
    }
  };
}
