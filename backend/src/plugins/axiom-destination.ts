// Pino destination that batches NDJSON entries and POSTs them to Axiom's
// `/v1/datasets/<dataset>/ingest` endpoint. Runs in-process — no worker thread
// — so the esbuild bundle ships as a single file (see FEAT-44 implementation
// notes and the spec's worker-thread gotcha).
//
// Auth and PII: only the Bearer token is sent in headers. The payload is
// whatever Pino formatted from log call sites, so the "no request bodies in
// logs" contract lives upstream in Fastify's request logger config, not here.

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_ENDPOINT = 'https://api.axiom.co';

export interface AxiomDestinationOptions {
  token: string;
  dataset: string;
  endpoint?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  fetchImpl?: typeof fetch;
  onError?: (err: unknown) => void;
}

export interface AxiomDestination {
  write(line: string): void;
  flush(): Promise<void>;
  end(): Promise<void>;
}

export function createAxiomDestination(
  options: AxiomDestinationOptions,
): AxiomDestination {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Default to a silent handler so a misconfigured caller can't crash the
  // app via a logging error. buildLoggerBundle (logger.ts) wires an explicit
  // onError that reports ingest failures to a dedicated stderr Pino logger.
  const noop: (err: unknown) => void = () => undefined;
  const onError = options.onError ?? noop;
  const url = `${endpoint}/v1/datasets/${encodeURIComponent(options.dataset)}/ingest`;
  const auth = `Bearer ${options.token}`;

  let buffer: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let pending: Promise<void> = Promise.resolve();

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref();
  }

  async function send(payload: string): Promise<void> {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/x-ndjson',
        },
        body: payload,
      });
      if (!response.ok) {
        onError(
          new Error(`axiom ingest responded ${response.status.toString()}`),
        );
      }
    } catch (err) {
      onError(err);
    }
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return pending;
    const payload = buffer.join('');
    buffer = [];
    pending = pending.then(() => send(payload));
    return pending;
  }

  return {
    write(line: string): void {
      buffer.push(line.endsWith('\n') ? line : `${line}\n`);
      if (buffer.length >= maxBatchSize) {
        void flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
    async end(): Promise<void> {
      await flush();
      await pending;
    },
  };
}
