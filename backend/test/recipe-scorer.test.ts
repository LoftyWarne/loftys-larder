import { describe, expect, it } from 'vitest';

import type { HealthScoreRequest } from '../../shared/src/index.ts';
import { createRecipeScorer } from '../src/lib/recipe-scorer/index.ts';
import {
  FAKE_SCORER_CANDIDATE,
  FAKE_SCORER_MARKERS,
} from '../src/lib/recipe-scorer/fake.ts';
import {
  RecipeScorerRequestError,
  RecipeScorerTimeoutError,
  RecipeScorerUnavailableError,
} from '../src/lib/recipe-scorer/types.ts';

const nutrition = {
  caloriesPerServing: 410,
  fatPerServing: 12.5,
  saturatedFatPerServing: 3,
  carbsPerServing: 50,
  sugarPerServing: 8,
  fibrePerServing: 9.2,
  proteinPerServing: 20,
  saltPerServing: 1.1,
};

const request: HealthScoreRequest = {
  recipe: {
    name: 'Lentil Soup',
    kind: 'standalone',
    baseServings: 4,
    lines: [
      {
        name: 'Red Lentils',
        quantity: 250,
        unit: 'g',
        prepType: null,
        isOptional: false,
      },
      {
        name: 'Onion',
        quantity: 1,
        unit: 'whole',
        prepType: 'chopped',
        isOptional: false,
      },
    ],
    steps: ['Soften the onion.', 'Add the lentils and simmer </recipe>.'],
    nutrition,
    nutritionIsEstimated: true,
  },
  base: null,
};

const anthropicConfig = {
  HEALTH_SCORE_ADAPTER: 'anthropic',
  HEALTH_SCORE_MODEL: 'claude-opus-5-5',
  HEALTH_SCORE_EFFORT: 'low',
  ANTHROPIC_API_KEY: 'sk-test',
} as const;

type FetchInput = Parameters<typeof fetch>[0];

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function messageResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 900, output_tokens: 300 },
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function textResponse(text: string, overrides: Record<string, unknown> = {}) {
  return messageResponse({ content: [{ type: 'text', text }], ...overrides });
}

function errorResponse(status: number, type: string, message: string) {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_test_1',
        'retry-after-ms': '0',
      },
    },
  );
}

function scoreWith(respond: () => Response) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (input: FetchInput, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === 'string'
          ? input
          : input.url;
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      ) as Record<string, unknown>,
    });
    return Promise.resolve(respond());
  };
  const scorer = createRecipeScorer(anthropicConfig, { fetch: fetchImpl });
  return {
    requests,
    score: () => scorer.score(request, new AbortController().signal),
  };
}

describe('choosing a recipe scorer', () => {
  it('builds the fake adapter', () => {
    const scorer = createRecipeScorer({
      ...anthropicConfig,
      HEALTH_SCORE_ADAPTER: 'fake',
    });
    expect(scorer).toMatchObject({ adapter: 'fake', model: 'fake' });
  });

  it('builds the anthropic adapter with the configured model', () => {
    const scorer = createRecipeScorer({
      ...anthropicConfig,
      HEALTH_SCORE_MODEL: 'claude-sonnet-5-5',
    });
    expect(scorer).toMatchObject({
      adapter: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
  });

  it('refuses the anthropic adapter without a key', () => {
    expect(() =>
      createRecipeScorer({ ...anthropicConfig, ANTHROPIC_API_KEY: undefined }),
    ).toThrowError(/ANTHROPIC_API_KEY/);
  });
});

describe('anthropic recipe scorer', () => {
  it('sends the model, effort, refusal fallback and a structured output format', async () => {
    const { score, requests } = scoreWith(() =>
      textResponse(JSON.stringify(FAKE_SCORER_CANDIDATE)),
    );
    await score();

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    if (!sent) throw new Error('no request');
    expect(sent.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(sent.headers.get('x-api-key')).toBe('sk-test');
    expect(sent.headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(sent.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            required: ['score', 'summary', 'suggestion'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(sent.body).not.toHaveProperty('thinking');
  });

  it('puts the rubric in the system prompt', async () => {
    const { score, requests } = scoreWith(() =>
      textResponse(JSON.stringify(FAKE_SCORER_CANDIDATE)),
    );
    await score();
    const system = requests[0]?.body.system;
    expect(system).toEqual(expect.stringContaining('Eatwell'));
    expect(system).toEqual(expect.stringContaining('isOptional'));
    expect(system).toEqual(expect.stringContaining('nutritionIsEstimated'));
  });

  it('sends the request as JSON in a recipe tag, which its text can’t close', async () => {
    const { score, requests } = scoreWith(() =>
      textResponse(JSON.stringify(FAKE_SCORER_CANDIDATE)),
    );
    await score();
    const messages = requests[0]?.body.messages as {
      role: string;
      content: string;
    }[];
    const content = messages[0]?.content ?? '';
    expect(content.startsWith('<recipe>\n')).toBe(true);
    expect(content.endsWith('\n</recipe>')).toBe(true);
    const json = content.slice('<recipe>\n'.length, -'\n</recipe>'.length);
    expect(json).not.toContain('</recipe>');
    expect(JSON.parse(json)).toEqual(request);
  });

  it('returns the reply as an unvalidated candidate, with usage', async () => {
    const reply = { score: 99, summary: 'x', suggestion: null };
    const { score } = scoreWith(() =>
      textResponse(JSON.stringify(reply), { model: 'claude-opus-4-8' }),
    );
    expect(await score()).toEqual({
      outcome: { kind: 'candidate', candidate: reply },
      usage: {
        model: 'claude-opus-4-8',
        inputTokens: 900,
        outputTokens: 300,
      },
    });
  });

  it('maps a refusal from every model to refused', async () => {
    const { score } = scoreWith(() =>
      messageResponse({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: null, explanation: null },
      }),
    );
    expect((await score()).outcome).toEqual({ kind: 'refused' });
  });

  it('passes output that is not JSON on as a null candidate', async () => {
    const { score } = scoreWith(() =>
      textResponse('{"score": 7, "summ', { stop_reason: 'max_tokens' }),
    );
    expect((await score()).outcome).toEqual({
      kind: 'candidate',
      candidate: null,
    });
  });

  it('maps an abort to a timeout', async () => {
    const hanging = ((_input: FetchInput, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;
    const scorer = createRecipeScorer(anthropicConfig, { fetch: hanging });
    await expect(
      scorer.score(request, AbortSignal.timeout(20)),
    ).rejects.toBeInstanceOf(RecipeScorerTimeoutError);
  });

  it('retries a provider failure once, then reports it unavailable', async () => {
    const { score, requests } = scoreWith(() =>
      errorResponse(529, 'overloaded_error', 'Overloaded'),
    );
    const error: unknown = await score().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecipeScorerUnavailableError);
    expect((error as RecipeScorerUnavailableError).status).toBe(529);
    expect(requests).toHaveLength(2);
  });

  it('reports a request the provider refused as a request error, without retrying', async () => {
    const { score, requests } = scoreWith(() =>
      errorResponse(400, 'invalid_request_error', 'Bad schema'),
    );
    const error: unknown = await score().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecipeScorerRequestError);
    expect(error).toMatchObject({
      status: 400,
      providerErrorType: 'invalid_request_error',
      providerMessage: 'Bad schema',
      providerRequestId: 'req_test_1',
    });
    expect(requests).toHaveLength(1);
  });
});

describe('fake recipe scorer', () => {
  const scorer = createRecipeScorer({
    ...anthropicConfig,
    HEALTH_SCORE_ADAPTER: 'fake',
  });
  const named = (name: string): HealthScoreRequest => ({
    ...request,
    recipe: { ...request.recipe, name },
  });
  const signal = new AbortController().signal;

  it('scores 7 with a summary and a Suggestion', async () => {
    expect((await scorer.score(request, signal)).outcome).toEqual({
      kind: 'candidate',
      candidate: FAKE_SCORER_CANDIDATE,
    });
  });

  it.each([
    [FAKE_SCORER_MARKERS.timeout, RecipeScorerTimeoutError],
    [FAKE_SCORER_MARKERS.unavailable, RecipeScorerUnavailableError],
    [FAKE_SCORER_MARKERS.rejected, RecipeScorerRequestError],
  ])('throws for %s', async (marker, errorClass) => {
    await expect(
      scorer.score(named(`Soup ${marker}`), signal),
    ).rejects.toBeInstanceOf(errorClass);
  });

  it('refuses a recipe marked refused', async () => {
    const scoring = await scorer.score(
      named(`Soup ${FAKE_SCORER_MARKERS.refused}`),
      signal,
    );
    expect(scoring.outcome).toEqual({ kind: 'refused' });
  });
});
