import type { FastifyBaseLogger } from 'fastify';

// One metadata-only line per model call, for every model feature (DEC-104,
// cross-cutting #22). Prompt content and model output never go here. `reqId`
// comes from the request logger's bindings (DEC-77).

export interface ModelUsage {
  feature: string;
  adapter: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  // What the call came to: a feature outcome or a domain error code.
  outcome: string;
}

export type ModelUsageDetails = Record<
  string,
  string | number | boolean | null
>;

export function logModelUsage(
  log: Pick<FastifyBaseLogger, 'info'>,
  usage: ModelUsage,
  details: ModelUsageDetails = {},
): void {
  log.info({ modelUsage: { ...details, ...usage } }, 'model call');
}
