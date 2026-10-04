import { describe, expect, it } from 'vitest';

import {
  checkImportLink,
  isPublicAddress,
} from '../src/lib/recipe-import/link-guard.ts';

describe('checkImportLink', () => {
  it.each([
    'https://www.bbcgoodfood.com/recipes/shakshuka',
    'https://recipes.example:443/soup?serves=4#method',
  ])('accepts %s', (link) => {
    expect(checkImportLink(link)).toMatchObject({ ok: true });
  });

  it.each([
    ['http', 'http://www.bbcgoodfood.com/recipes/shakshuka', 'not_https'],
    ['another scheme', 'ftp://recipes.example/soup', 'not_https'],
    ['javascript', 'javascript:alert(1)', 'not_https'],
    ['a file', 'file:///etc/passwd', 'not_https'],
    ['not a link', 'shakshuka', 'not_https'],
    ['a user name', 'https://cook@recipes.example/', 'credentials'],
    ['a password', 'https://cook:pw@recipes.example/', 'credentials'],
    ['another port', 'https://recipes.example:8443/', 'port'],
  ])('refuses %s', (_label, link, reason) => {
    expect(checkImportLink(link)).toEqual({ ok: false, reason });
  });
});

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '151.101.0.81',
    '172.32.0.1',
    '2606:4700::6810:84e5',
    '2a00:1450:4009:81f::200e',
  ])('allows the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['private', '10.0.0.1'],
    ['private', '172.16.0.1'],
    ['private', '172.31.255.255'],
    ['private', '192.168.1.1'],
    ['loopback', '127.0.0.1'],
    ['loopback', '127.255.255.254'],
    ['link-local (cloud metadata)', '169.254.169.254'],
    ['shared address space', '100.64.0.1'],
    ['"this network"', '0.0.0.0'],
    ['broadcast', '255.255.255.255'],
    ['multicast', '224.0.0.1'],
    ['documentation', '192.0.2.1'],
    ['benchmarking', '198.18.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 link-local with a zone', 'fe80::1%eth0'],
    ['IPv6 unique local', 'fc00::1'],
    ["Fly's private network", 'fdaa:0:1:a7b::3'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback, in hex', '::ffff:7f00:1'],
    ['IPv4-mapped private', '::ffff:10.0.0.1'],
    ['IPv4-mapped link-local', '::ffff:169.254.169.254'],
    ['NAT64 of a private address', '64:ff9b::a00:1'],
    ['6to4 of a private address', '2002:a00:1::'],
    ['Teredo', '2001::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['not an address', 'recipes.example'],
  ])('refuses %s: %s', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
