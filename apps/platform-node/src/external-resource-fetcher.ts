import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

import type { ExternalResourceFetcher } from '@floway-dev/platform';

const blockedAddresses = new BlockList();

// External-resource URLs are attacker-controlled. Reject every IANA
// special-purpose range rather than only RFC1918 so DNS cannot pivot a fetch
// into loopback, link-local, documentation, benchmarking, multicast, or an
// address reserved for future local use.
// https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
// https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
const blockedIpv4Subnets = [
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
] as const;

const blockedIpv6Subnets = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const;

for (const [network, prefix] of blockedIpv4Subnets) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of blockedIpv6Subnets) blockedAddresses.addSubnet(network, prefix, 'ipv6');

export const isPublicIpAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  if (family === 6) {
    // DNS should normally return IPv4 as family 4. Refuse mapped family-6
    // spellings outright so they cannot bypass the IPv4 registry ranges.
    if (address.toLowerCase().startsWith('::ffff:')) return false;
    return !blockedAddresses.check(address, 'ipv6');
  }
  return false;
};

type ResolveAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const resolveAll: ResolveAll = (hostname, options, callback) => lookup(hostname, options, callback);

const nonPublicTargetError = (): NodeJS.ErrnoException => Object.assign(
  new Error('External resource target did not resolve exclusively to public IP addresses'),
  { code: 'ENETUNREACH' },
);

export const createPublicAddressLookup = (resolve: ResolveAll = resolveAll): LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, [], 0);
        return;
      }
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
        callback(nonPublicTargetError(), [], 0);
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const [selected] = addresses;
      callback(null, selected.address, selected.family);
    });
  };

export const createNodeExternalResourceFetcher = (): ExternalResourceFetcher => {
  const dispatcher = new Agent({ connect: { lookup: createPublicAddressLookup() } });
  return async (url, signal) => {
    // Undici bypasses `lookup` for IP literals, so validate them before the
    // dispatcher sees the request. URL.hostname retains brackets on IPv6.
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
    if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) throw nonPublicTargetError();
    const response = await undiciFetch(url, { dispatcher, redirect: 'manual', signal });
    const body = response.body === null
      ? null
      : (() => {
          const reader = response.body.getReader();
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          });
        })();
    return new Response(body, {
      headers: [...response.headers],
      status: response.status,
      statusText: response.statusText,
    });
  };
};
