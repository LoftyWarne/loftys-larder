import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createResendSender } from '../src/auth/resend.ts';

describe('createResendSender', () => {
  it('shows the code as two groups of four, as the code field does', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const send = createResendSender({
      apiKey: 'key',
      from: 'Lofty’s Larder <sign-in@example.com>',
      log: pino({ level: 'silent' }),
      fetchImpl,
    });

    await send({ to: 'Cook@Example.com', code: '12345678' });

    const init = fetchImpl.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('expected a JSON body');
    const body = JSON.parse(init.body) as { to: string[]; text: string };
    expect(body.to).toEqual(['cook@example.com']);
    expect(body.text).toContain('\n1234 5678\n');
    expect(body.text).not.toContain('12345678');
  });
});
