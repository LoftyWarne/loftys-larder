// Addresses allowed to tell us the client IP through `X-Forwarded-For`.
// Fastify walks the header from the right and stops at the first address not
// on this list, so client-supplied entries to the left never count.
//
// - Fly's proxy reaches the app from a private address (`uniquelocal` covers
//   both its 172.16/12 and fdaa::/16 ranges); `loopback` covers local dev.
// - Cloudflare's edges, so a request through the custom domain resolves to the
//   client Cloudflare saw. A request straight to `*.fly.dev` skips Cloudflare
//   and resolves to the address Fly saw, which the client can't fake either.
//
// Cloudflare's ranges are from https://www.cloudflare.com/ips/ (2026-10-24).
// They rarely change; a missing range only makes those clients share a
// rate-limit bucket keyed by the edge's address.
export const TRUSTED_PROXIES: readonly string[] = [
  'loopback',
  'uniquelocal',
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
