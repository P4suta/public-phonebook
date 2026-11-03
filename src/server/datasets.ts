export interface DatasetObjectMetadata {
  readonly size: number;
  readonly httpEtag: string;
}

export interface DatasetObject extends DatasetObjectMetadata {
  readonly body: ReadableStream<Uint8Array>;
}

/** The bytes from `offset` that a ranged read returns, `length` of them. */
export interface DatasetByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface DatasetReader {
  get(
    key: string,
    options?: { readonly range?: DatasetByteRange },
  ): Promise<DatasetObject | null>;
  head(key: string): Promise<DatasetObjectMetadata | null>;
}
