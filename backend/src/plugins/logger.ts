import type { FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';

export function buildLoggerOptions(
  config: Config,
): FastifyServerOptions['logger'] {
  return {
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV },
  };
}

export function buildServerOptions(config: Config): FastifyServerOptions {
  return {
    logger: buildLoggerOptions(config),
    genReqId: () => randomUUID(),
    disableRequestLogging: false,
  };
}
