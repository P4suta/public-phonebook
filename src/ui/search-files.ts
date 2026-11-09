import type { SearchFile } from "../core/file-search.ts";
import type { TemporarySearchFiles } from "./file-search-service.ts";

interface AccessHandle {
  read(bytes: Uint8Array, options: { readonly at: number }): number;
  write(bytes: Uint8Array, options: { readonly at: number }): number;
  getSize(): number;
  close(): void;
}

interface WorkerFile extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<AccessHandle>;
}

function hasAccess(file: FileSystemFileHandle): file is WorkerFile {
  return (
    "createSyncAccessHandle" in file &&
    typeof file.createSyncAccessHandle === "function"
  );
}

const directoryName = "public-phonebook-search";
const lockPrefix = "public-phonebook-search:";

async function removeTemporary(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError"))
      throw error;
  }
}

async function storageOperation<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${phase}: ${String(error)}`, { cause: error });
  }
}

export async function temporarySearchFiles(): Promise<TemporarySearchFiles> {
  const root = await storageOperation("Search storage root", () =>
    navigator.storage.getDirectory(),
  );
  const parent = await storageOperation("Search storage directory", () =>
    root.getDirectoryHandle(directoryName, { create: true }),
  );
  for await (const name of parent.keys()) {
    await navigator.locks.request(
      `${lockPrefix}${name}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock) await removeTemporary(parent, name);
      },
    );
  }
  const name = crypto.randomUUID();
  let acquired: () => void = () => {};
  let rejected: (reason: unknown) => void = () => {};
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    rejected = reject;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifetime = navigator.locks.request(`${lockPrefix}${name}`, async () => {
    acquired();
    await done;
  });
  void lifetime.catch(rejected);
  await ready;
  const handles: AccessHandle[] = [];
  let closed = false;
  async function dispose(): Promise<void> {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    try {
      for (const handle of handles) {
        try {
          handle.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await removeTemporary(parent, name);
      } catch (error) {
        errors.push(error);
      }
    } finally {
      release();
      await lifetime;
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Search file cleanup failed");
  }
  try {
    const directory = await parent.getDirectoryHandle(name, { create: true });
    async function open(fileName: string): Promise<SearchFile> {
      const file = await directory.getFileHandle(fileName, { create: true });
      if (!hasAccess(file))
        throw new Error("Synchronous search storage is unavailable");
      const access = await storageOperation(
        `Search file ${fileName} access`,
        () => file.createSyncAccessHandle(),
      );
      handles.push(access);
      return {
        read: (buffer, at) => access.read(buffer, { at }),
        write: (buffer, at) => access.write(buffer, { at }),
        getSize: () => access.getSize(),
      };
    }
    const raw = await open("index");
    const folded = await open("folded-names");
    const names = await open("name-offsets");
    const phones = await open("telephone-offsets");
    return { raw, folded, names, phones, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Search storage failed");
    }
    throw error;
  }
}
