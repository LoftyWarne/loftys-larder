import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CLIENT_IP_HEADER, type Auth } from '../auth/index.ts';
import {
  emailDomainForLog,
  ENTER_CODE_PATH,
  SEND_CODE_PATH,
  signInEmail,
} from '../auth/sign-in-email.ts';
import type { Config } from '../config.ts';

export interface RegisterAuthOptions {
  auth: Auth;
  config: Config;
}

function isExempt(req: FastifyRequest, config: Config): boolean {
  const url = req.url;
  if (url.startsWith('/api/auth/')) return true;
  if (url.startsWith('/api/health')) return true;
  if (
    config.NODE_ENV !== 'production' &&
    url.startsWith('/api/trpc/health.ping')
  ) {
    return true;
  }
  // The bundled prod backend serves the SPA same-origin via @fastify/static
  // (FEAT-05, `STATIC_DIR`). The SPA shell, its assets, and the SPA fallback
  // for non-/api paths all need to load without a session — the SPA itself
  // routes the user to `/sign-in` client-side. tRPC / Better Auth API calls
  // remain protected because they live under `/api/`.
  if (req.method === 'GET' && !url.startsWith('/api/')) return true;
  return false;
}

// The email-OTP plugin mounts password-reset, email-change and verification
// routes alongside sign-in. Only send + sign-in are part of our auth surface
// (DEC-114); `check-verification-otp` would also be a code oracle. Better
// Auth's `disabledPaths` (auth/index.ts) blocks the same routes again.
const SIGN_IN_CODE_ROUTES = new Set([SEND_CODE_PATH, ENTER_CODE_PATH]);

// Better Auth's paths are plain segments. Anything else (`.`, `\`, `%`, an
// empty segment) would be tidied into a real route only when we forward the
// request, after the gate and the sign-in limits had matched the untidied
// path and let it through.
const PLAIN_AUTH_PATH = /^\/api\/auth(?:\/[A-Za-z0-9_-]+)+$/;

function isBlockedAuthRoute(path: string): boolean {
  if (!PLAIN_AUTH_PATH.test(path)) return true;
  if (SIGN_IN_CODE_ROUTES.has(path)) return false;
  return (
    path.startsWith('/api/auth/email-otp/') ||
    path.startsWith('/api/auth/forget-password/')
  );
}

type SignInCodeGate =
  | { kind: 'pass' }
  | { kind: 'reply'; status: number; body: Record<string, unknown> };

// The plugin stores a code for any address and signs up whoever enters it, so
// the allow-list (DEC-17) has to stop both requests before Better Auth sees
// them; a short code is guessable where a magic-link token wasn't. Replies
// mimic the plugin's own, but membership can still be learned: only listed
// addresses are rate-limited and reach the database and Resend (DEC-114
// accepts this at household scale).
function gateSignInCode(
  path: string,
  body: unknown,
  allowedEmails: ReadonlySet<string>,
): SignInCodeGate {
  if (path !== SEND_CODE_PATH && path !== ENTER_CODE_PATH) {
    return { kind: 'pass' };
  }
  const type =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).type
      : undefined;
  if (path === SEND_CODE_PATH && type !== 'sign-in') {
    return {
      kind: 'reply',
      status: 400,
      body: { code: 'INVALID_OTP_TYPE', message: 'Invalid OTP type' },
    };
  }
  if (allowedEmails.has(signInEmail(body))) return { kind: 'pass' };
  return path === SEND_CODE_PATH
    ? { kind: 'reply', status: 200, body: { success: true } }
    : {
        kind: 'reply',
        status: 400,
        body: { code: 'INVALID_OTP', message: 'Invalid OTP' },
      };
}

function buildHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }
  return headers;
}

export function registerAuth(
  app: FastifyInstance,
  { auth, config }: RegisterAuthOptions,
): void {
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  const allowedEmails = new Set(config.MAGIC_LINK_ALLOWED_EMAILS);

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/api/auth/*',
    async handler(req, reply) {
      const path = req.url.split('?', 1)[0] ?? '';
      if (isBlockedAuthRoute(path)) {
        reply.callNotFound();
        return reply;
      }
      const gate = gateSignInCode(path, req.body, allowedEmails);
      if (gate.kind === 'reply') {
        if (gate.status === 200) {
          req.log.warn(
            { emailDomain: emailDomainForLog(signInEmail(req.body)) },
            'sign-in code request for non-allow-listed email; not sending',
          );
        }
        return reply.code(gate.status).send(gate.body);
      }
      const url = new URL(req.url, config.BETTER_AUTH_URL.replace(/\/$/, ''));
      const headers = buildHeaders(req);
      // Better Auth's own limiter would otherwise read the leftmost
      // X-Forwarded-For entry, which the client controls.
      headers.set(CLIENT_IP_HEADER, req.ip);
      const init: RequestInit = { method: req.method, headers };
      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        req.body !== undefined
      ) {
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        init.body =
          typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      const response = await auth.handler(new Request(url.toString(), init));

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          reply.header('set-cookie', value);
        } else {
          reply.header(key, value);
        }
      });
      const body = response.body ? await response.text() : null;
      await reply.send(body);
    },
  });

  app.addHook(
    'preHandler',
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/auth/')) return;

      const result = await auth.api.getSession({
        headers: buildHeaders(req),
      });

      if (result) {
        req.session = result.session;
        req.user = result.user;
        return;
      }

      if (isExempt(req, config)) return;

      await reply.code(401).send({ error: 'Unauthorized' });
    },
  );
}
