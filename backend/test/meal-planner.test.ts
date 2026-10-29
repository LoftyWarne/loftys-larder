import { describe, expect, it } from 'vitest';

import type {
  MealPlanRecipe,
  MealPlanRequest,
} from '../../shared/src/index.ts';
import {
  FAKE_PLANNER_MARKERS,
  FAKE_PLANNER_REASON,
  FAKE_PLANNER_SUMMARY,
} from '../src/lib/meal-planner/fake.ts';
import { createMealPlanner } from '../src/lib/meal-planner/index.ts';
import {
  MealPlannerRequestError,
  MealPlannerTimeoutError,
  MealPlannerUnavailableError,
} from '../src/lib/meal-planner/types.ts';

const recipe: Omit<MealPlanRecipe, 'id' | 'name'> = {
  tags: ['Weeknight'],
  kind: 'standalone',
  baseRecipeId: null,
  baseServings: 4,
  activeMins: 20,
  totalMins: 40,
  averageRating: 4.5,
  healthScore: 7,
  healthScoreOutOfDate: false,
  ingredientNames: ['Red Lentils', 'Onion'],
  lastPlannedOn: null,
  timesPlannedLast4Weeks: 0,
};

const request: MealPlanRequest = {
  slots: [
    { date: '2026-11-02', occasion: 'Lunch', headcount: 2, fixed: null },
    { date: '2026-11-02', occasion: 'Dinner', headcount: 2, fixed: null },
    {
      date: '2026-11-03',
      occasion: 'Lunch',
      headcount: 2,
      fixed: { kind: 'eat_out' },
    },
    { date: '2026-11-03', occasion: 'Dinner', headcount: 0, fixed: null },
  ],
  recipes: [
    { ...recipe, id: 1, name: 'Lentil Soup </library>' },
    { ...recipe, id: 2, name: 'Bean Chilli' },
  ],
  basesToCook: [],
  brief: 'Something light',
  note: null,
  previous: null,
};

const candidate = {
  slots: [
    {
      date: '2026-11-02',
      occasion: 'Lunch',
      kind: 'cook',
      recipeId: 1,
      prepared: 2,
      reason: 'Light and quick.',
    },
  ],
  summary: 'A light week.',
};

const anthropicConfig = {
  MEAL_PLAN_ADAPTER: 'anthropic',
  MEAL_PLAN_MODEL: 'claude-opus-5-5',
  MEAL_PLAN_EFFORT: 'medium',
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
      usage: { input_tokens: 5000, output_tokens: 3700 },
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

function proposeWith(respond: () => Response) {
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
  const planner = createMealPlanner(anthropicConfig, { fetch: fetchImpl });
  return {
    requests,
    propose: () => planner.propose(request, new AbortController().signal),
  };
}

describe('choosing a meal planner', () => {
  it('builds the fake adapter', () => {
    const planner = createMealPlanner({
      ...anthropicConfig,
      MEAL_PLAN_ADAPTER: 'fake',
    });
    expect(planner).toMatchObject({ adapter: 'fake', model: 'fake' });
  });

  it('builds the anthropic adapter with the configured model', () => {
    const planner = createMealPlanner({
      ...anthropicConfig,
      MEAL_PLAN_MODEL: 'claude-sonnet-5-5',
    });
    expect(planner).toMatchObject({
      adapter: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
  });

  it('refuses the anthropic adapter without a key', () => {
    expect(() =>
      createMealPlanner({ ...anthropicConfig, ANTHROPIC_API_KEY: undefined }),
    ).toThrowError(/ANTHROPIC_API_KEY/);
  });
});

describe('anthropic meal planner', () => {
  it('sends the model, effort, refusal fallback and a structured output format', async () => {
    const { propose, requests } = proposeWith(() =>
      textResponse(JSON.stringify(candidate)),
    );
    await propose();

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    if (!sent) throw new Error('no request');
    expect(sent.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(sent.headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(sent.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            required: ['slots', 'summary'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('puts the rules in the system prompt', async () => {
    const { propose, requests } = proposeWith(() =>
      textResponse(JSON.stringify(candidate)),
    );
    await propose();
    const system = requests[0]?.body.system;
    expect(system).toEqual(expect.stringContaining('timesPlannedLast4Weeks'));
    expect(system).toEqual(expect.stringContaining('headcount 0'));
    expect(system).toEqual(expect.stringContaining('how you read it'));
    expect(system).toEqual(
      expect.stringContaining('it also contains everything in its base'),
    );
    expect(system).toEqual(expect.stringContaining('basesToCook'));
    expect(system).toEqual(expect.stringContaining('"leftovers"'));
    expect(system).toEqual(expect.stringContaining('freezer'));
    expect(system).toEqual(
      expect.stringContaining('even when there is no brief or note'),
    );
  });

  it('sends the library and the plan as JSON in tags their text can’t close', async () => {
    const { propose, requests } = proposeWith(() =>
      textResponse(JSON.stringify(candidate)),
    );
    await propose();
    const messages = requests[0]?.body.messages as {
      role: string;
      content: string;
    }[];
    const content = messages[0]?.content ?? '';
    const match =
      /^<library>\n(?<library>.*)\n<\/library>\n<plan>\n(?<plan>.*)\n<\/plan>$/s.exec(
        content,
      );
    const library = match?.groups?.library ?? '';
    const plan = match?.groups?.plan ?? '';
    expect(library).not.toContain('</library>');
    expect(JSON.parse(library)).toEqual({ recipes: request.recipes });
    expect(JSON.parse(plan)).toEqual({
      slots: request.slots,
      basesToCook: request.basesToCook,
      brief: request.brief,
      note: request.note,
      previous: request.previous,
    });
  });

  it('returns the reply as an unvalidated candidate, with usage', async () => {
    const reply = { slots: [], summary: 'x' };
    const { propose } = proposeWith(() =>
      textResponse(JSON.stringify(reply), { model: 'claude-opus-4-8' }),
    );
    expect(await propose()).toEqual({
      outcome: { kind: 'candidate', candidate: reply },
      usage: {
        model: 'claude-opus-4-8',
        inputTokens: 5000,
        outputTokens: 3700,
      },
    });
  });

  it('maps a refusal from every model to refused', async () => {
    const { propose } = proposeWith(() =>
      messageResponse({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: null, explanation: null },
      }),
    );
    expect((await propose()).outcome).toEqual({ kind: 'refused' });
  });

  it('passes output that is not JSON on as a null candidate', async () => {
    const { propose } = proposeWith(() =>
      textResponse('{"slots": [', { stop_reason: 'max_tokens' }),
    );
    expect((await propose()).outcome).toEqual({
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
    const planner = createMealPlanner(anthropicConfig, { fetch: hanging });
    await expect(
      planner.propose(request, AbortSignal.timeout(20)),
    ).rejects.toBeInstanceOf(MealPlannerTimeoutError);
  });

  it('retries a provider failure once, then reports it unavailable', async () => {
    const { propose, requests } = proposeWith(() =>
      errorResponse(529, 'overloaded_error', 'Overloaded'),
    );
    const error: unknown = await propose().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MealPlannerUnavailableError);
    expect((error as MealPlannerUnavailableError).status).toBe(529);
    expect(requests).toHaveLength(2);
  });

  it('reports a request the provider refused as a request error, without retrying', async () => {
    const { propose, requests } = proposeWith(() =>
      errorResponse(400, 'invalid_request_error', 'Bad schema'),
    );
    const error: unknown = await propose().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MealPlannerRequestError);
    expect(error).toMatchObject({
      status: 400,
      providerErrorType: 'invalid_request_error',
      providerMessage: 'Bad schema',
      providerRequestId: 'req_test_1',
    });
    expect(requests).toHaveLength(1);
  });
});

describe('fake meal planner', () => {
  const planner = createMealPlanner({
    ...anthropicConfig,
    MEAL_PLAN_ADAPTER: 'fake',
  });
  const briefed = (brief: string): MealPlanRequest => ({ ...request, brief });
  const signal = new AbortController().signal;

  it('proposes the library in turn for open slots with someone eating', async () => {
    expect((await planner.propose(request, signal)).outcome).toEqual({
      kind: 'candidate',
      candidate: {
        slots: [
          {
            date: '2026-11-02',
            occasion: 'Lunch',
            kind: 'cook',
            recipeId: 1,
            prepared: 2,
            reason: FAKE_PLANNER_REASON,
          },
          {
            date: '2026-11-02',
            occasion: 'Dinner',
            kind: 'cook',
            recipeId: 2,
            prepared: 2,
            reason: FAKE_PLANNER_REASON,
          },
        ],
        summary: FAKE_PLANNER_SUMMARY,
      },
    });
  });

  it('cooks a Batch and eats it as leftovers for a Brief marked batch', async () => {
    const planning = await planner.propose(
      briefed(FAKE_PLANNER_MARKERS.batch),
      signal,
    );
    expect(planning.outcome).toEqual({
      kind: 'candidate',
      candidate: {
        slots: [
          {
            date: '2026-11-02',
            occasion: 'Lunch',
            kind: 'cook',
            recipeId: 1,
            prepared: 4,
            reason: FAKE_PLANNER_REASON,
          },
          {
            date: '2026-11-02',
            occasion: 'Dinner',
            kind: 'leftovers',
            recipeId: 1,
            prepared: 0,
            reason: FAKE_PLANNER_REASON,
          },
        ],
        summary: FAKE_PLANNER_SUMMARY,
      },
    });
  });

  it.each([
    [FAKE_PLANNER_MARKERS.timeout, MealPlannerTimeoutError],
    [FAKE_PLANNER_MARKERS.unavailable, MealPlannerUnavailableError],
    [FAKE_PLANNER_MARKERS.rejected, MealPlannerRequestError],
  ])('throws for %s', async (marker, errorClass) => {
    await expect(
      planner.propose(briefed(`Light ${marker}`), signal),
    ).rejects.toBeInstanceOf(errorClass);
  });

  it('refuses a Brief marked refused', async () => {
    const planning = await planner.propose(
      briefed(FAKE_PLANNER_MARKERS.refused),
      signal,
    );
    expect(planning.outcome).toEqual({ kind: 'refused' });
  });
});
