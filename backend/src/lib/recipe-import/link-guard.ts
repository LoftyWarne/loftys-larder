import { BlockList, isIP } from 'node:net';

// The SSRF guard for link imports (DEC-107). `checkImportLink` vets the link
// itself; `isPublicAddress` vets every address the fetch would connect to,
// after DNS and after every redirect.

export type LinkRefusal = 'not_https' | 'credentials' | 'port' | 'address';

export type LinkCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: LinkRefusal };

export function checkImportLink(link: string | URL): LinkCheck {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, reason: 'not_https' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials' };
  }
  // The URL parser drops `:443`, so any port left is another one.
  if (url.port !== '') return { ok: false, reason: 'port' };
  return { ok: true, url };
}

// IANA's special-purpose IPv4 ranges, plus multicast and reserved space.
const NON_PUBLIC_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// Special-purpose ranges inside global unicast: protocol assignments
// (including Teredo), documentation and 6to4, which can wrap a private IPv4
// address.
const NON_PUBLIC_V6_GLOBAL: readonly [string, number][] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const nonPublicV4 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_V4) {
  nonPublicV4.addSubnet(network, prefix, 'ipv4');
}

const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

const nonPublicV6Global = new BlockList();
for (const [network, prefix] of NON_PUBLIC_V6_GLOBAL) {
  nonPublicV6Global.addSubnet(network, prefix, 'ipv6');
}

// IPv6 is allowed only in global unicast (2000::/3). That refuses loopback,
// link-local, unique local (Fly's private `fdaa::` network, which reaches
// the database) and IPv4-mapped addresses wholesale.
export function isPublicAddress(address: string): boolean {
  try {
    switch (isIP(address)) {
      case 4:
        return !nonPublicV4.check(address, 'ipv4');
      case 6:
        return (
          globalUnicastV6.check(address, 'ipv6') &&
          !nonPublicV6Global.check(address, 'ipv6')
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}
