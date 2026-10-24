import { groupSignInCode } from '../../../shared/src/index.ts';
import type { FastifyBaseLogger } from 'fastify';

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface SignInCodePayload {
  to: string;
  code: string;
}

export type SignInCodeSender = (payload: SignInCodePayload) => Promise<void>;

export interface ResendSenderOptions {
  apiKey: string;
  from: string;
  log: FastifyBaseLogger;
  // Injectable so tests don't need network; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

function buildBody(code: string): string {
  return [
    'Your Lofty’s Larder sign-in code is:',
    '',
    groupSignInCode(code),
    '',
    'Enter it in the app to sign in. It expires in 10 minutes. If you did not request it, ignore this email.',
  ].join('\n');
}

// Single-household MVP gate (DEC-17). Wraps any transport so the allow-list
// applies whether production is using Resend or a test injects a spy.
export function withAllowList(
  inner: SignInCodeSender,
  allowedEmails: readonly string[],
  log: FastifyBaseLogger,
): SignInCodeSender {
  const allowed = new Set(allowedEmails.map((entry) => entry.toLowerCase()));
  return async ({ to, code }) => {
    const normalised = to.toLowerCase();
    if (!allowed.has(normalised)) {
      log.warn(
        { email: normalised },
        'sign-in code request for non-allow-listed email; not sending',
      );
      return;
    }
    await inner({ to: normalised, code });
  };
}

export function createResendSender(
  opts: ResendSenderOptions,
): SignInCodeSender {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async ({ to, code }) => {
    const normalised = to.toLowerCase();

    const response = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: opts.from,
        to: [normalised],
        subject: 'Your Lofty’s Larder sign-in code',
        text: buildBody(code),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      opts.log.error(
        { status: response.status, detail },
        'Resend rejected sign-in code send',
      );
      throw new Error(`Resend send failed: ${String(response.status)}`);
    }
  };
}
