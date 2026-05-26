import type { FastifyBaseLogger } from 'fastify';

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface MagicLinkPayload {
  to: string;
  url: string;
}

export type MagicLinkSender = (payload: MagicLinkPayload) => Promise<void>;

export interface ResendSenderOptions {
  apiKey: string;
  from: string;
  log: FastifyBaseLogger;
  // Injectable so tests don't need network; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

function buildBody(url: string): string {
  return [
    'Sign in to Lofty’s Larder by clicking the link below.',
    '',
    url,
    '',
    'This link expires in 10 minutes. If you did not request it, ignore this email.',
  ].join('\n');
}

// Single-household MVP gate (DEC-17). Wraps any transport so the allow-list
// applies whether production is using Resend or a test injects a spy.
export function withAllowList(
  inner: MagicLinkSender,
  allowedEmails: readonly string[],
  log: FastifyBaseLogger,
): MagicLinkSender {
  const allowed = new Set(allowedEmails.map((entry) => entry.toLowerCase()));
  return async ({ to, url }) => {
    const normalised = to.toLowerCase();
    if (!allowed.has(normalised)) {
      log.warn(
        { email: normalised },
        'magic-link request for non-allow-listed email; not sending',
      );
      return;
    }
    await inner({ to: normalised, url });
  };
}

export function createResendSender(opts: ResendSenderOptions): MagicLinkSender {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return async ({ to, url }) => {
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
        subject: 'Your Lofty’s Larder sign-in link',
        text: buildBody(url),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      opts.log.error(
        { status: response.status, detail },
        'Resend rejected magic-link send',
      );
      throw new Error(`Resend send failed: ${String(response.status)}`);
    }
  };
}
