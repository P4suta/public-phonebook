import type { SearchFile } from "@public-phonebook/directory/file-search";

export class MemoryFile implements SearchFile {
  bytes: Uint8Array;
  largestRead = 0;
  largestWrite = 0;

  constructor(bytes: Uint8Array = new Uint8Array()) {
    this.bytes = bytes;
  }
  getSize(): number {
    return this.bytes.length;
  }
  read(buffer: Uint8Array, at: number): number {
    this.largestRead = Math.max(this.largestRead, buffer.length);
    const part = this.bytes.subarray(at, at + buffer.length);
    buffer.set(part);
    return part.length;
  }
  write(buffer: Uint8Array, at: number): number {
    this.largestWrite = Math.max(this.largestWrite, buffer.length);
    if (at + buffer.length > this.bytes.length) {
      const grown = new Uint8Array(at + buffer.length);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(buffer, at);
    return buffer.length;
  }
}
