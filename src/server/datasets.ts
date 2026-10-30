export interface DatasetObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpEtag: string;
}

export interface DatasetReader {
  get(key: string): Promise<DatasetObject | null>;
}
