import pino, { type Logger, type LoggerOptions } from 'pino';
import pretty from 'pino-pretty';
import type { Config } from '../config.ts';
import {
  createAxiomDestination,
  type AxiomDestination,
} from './axiom-destination.ts';

export interface LoggerBundle {
  logger: Logger;
  // Held so the shutdown path can flush in-flight log batches. Null when
  // Axiom is not wired (dev, test, or prod when explicitly disabled in tests).
  axiom: AxiomDestination | null;
}

export interface BuildLoggerOptions {
  // Injectable for tests so we can intercept the outgoing HTTP without
  // touching the real ingest endpoint.
  fetchImpl?: typeof fetch;
  // Injectable for tests to capture pretty / multistream output without
  // mutating process.stdout.
  stdout?: NodeJS.WritableStream;
  // Where Axiom ingest failures are reported. Deliberately separate from the
  // main stream so a failing send can't loop back through the Axiom
  // destination. Defaults to stderr; injectable for tests.
  errorStream?: NodeJS.WritableStream;
}

export function buildLoggerBundle(
  config: Config,
  options: BuildLoggerOptions = {},
): LoggerBundle {
  const baseOptions: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV },
  };
  const stdout = options.stdout ?? process.stdout;

  if (config.NODE_ENV === 'production') {
    const { AXIOM_TOKEN, AXIOM_DATASET } = config;
    // Refinement in config.ts guarantees both are set when NODE_ENV is prod;
    // surface the contradiction loudly if it ever drifts.
    if (!AXIOM_TOKEN || !AXIOM_DATASET) {
      throw new Error(
        'AXIOM_TOKEN and AXIOM_DATASET must be set in production (config refinement)',
      );
    }
    // A dedicated stderr logger surfaces ingest failures (bad token, wrong
    // dataset, region mismatch, non-2xx) in Fly logs. Without this the
    // destination's onError defaults to a no-op and logs silently stop
    // reaching Axiom. It writes to its own stream, not the Axiom multistream,
    // so reporting a failed send can't trigger another send.
    const diagnostics = pino(
      baseOptions,
      options.errorStream ?? process.stderr,
    );
    const axiom = createAxiomDestination({
      token: AXIOM_TOKEN,
      dataset: AXIOM_DATASET,
      endpoint: config.AXIOM_ENDPOINT,
      fetchImpl: options.fetchImpl,
      onError: (err) => {
        diagnostics.error({ err }, 'axiom ingest failed');
      },
    });
    const stream = pino.multistream([
      { stream: stdout },
      {
        stream: {
          write: (line: string) => {
            axiom.write(line);
          },
        },
      },
    ]);
    return { logger: pino(baseOptions, stream), axiom };
  }

  if (config.NODE_ENV === 'development') {
    const prettyStream = pretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      destination: stdout,
    });
    return { logger: pino(baseOptions, prettyStream), axiom: null };
  }

  return { logger: pino(baseOptions, stdout), axiom: null };
}
