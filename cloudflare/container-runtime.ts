const DIRECTORY_PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const READINESS_ATTEMPTS = 45;
const READINESS_DELAY_MS = 500;
const PROBE_TIMEOUT_MS = 1_000;
const HEALTHY_STATUS = 200;
const READINESS_URL = "http://container/healthz";

export interface DirectoryStartOptions {
  readonly image: string;
  readonly instance: "lite";
  readonly enableInternet: false;
}

export interface DirectoryImage {
  readonly image: string;
}

export interface DirectoryPort {
  fetch(request: Request): Promise<Response>;
}

export interface DirectoryContainer {
  readonly running: boolean;
  readonly images: Readonly<Record<string, string>>;
  start(options: DirectoryStartOptions): void;
  inspect(): Promise<DirectoryImage | null>;
  destroy(): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  getTcpPort(port: number): DirectoryPort;
}

type Pause = (durationMs: number) => Promise<void>;

function pause(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export class DirectoryRuntime {
  readonly #container: DirectoryContainer;
  readonly #pause: Pause;
  #pending: Promise<void> | undefined;

  constructor(container: DirectoryContainer, wait: Pause = pause) {
    this.#container = container;
    this.#pause = wait;
  }

  async restore(): Promise<void> {
    if (this.#container.running)
      await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const pending =
      this.#pending ??
      this.#prepare().finally(() => {
        this.#pending = undefined;
      });
    this.#pending = pending;
    await pending;
    return this.#container.getTcpPort(DIRECTORY_PORT).fetch(request);
  }

  async #prepare(): Promise<void> {
    const image = this.#container.images.directory;
    if (!image) throw new Error("The directory image is missing");
    const current = await this.#container.inspect();
    if (current && current.image !== image) await this.#container.destroy();
    const port = this.#container.getTcpPort(DIRECTORY_PORT);
    let lastFailure: unknown;
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      try {
        if (!this.#container.running)
          this.#container.start({
            image,
            instance: "lite",
            enableInternet: false,
          });
        await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        const response = await port.fetch(
          new Request(READINESS_URL, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          }),
        );
        const ready = response.status === HEALTHY_STATUS;
        await response.body?.cancel();
        if (ready) return;
        lastFailure = new Error(
          "Directory health returned HTTP " + response.status,
        );
      } catch (error: unknown) {
        lastFailure = error;
      }
      if (attempt + 1 < READINESS_ATTEMPTS)
        await this.#pause(READINESS_DELAY_MS);
    }
    throw new Error("The directory did not become ready", {
      cause: lastFailure,
    });
  }
}
