import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Any user may enter an LLM server, so the server never calls one inside its own network (trips DECISIONS-LOG
// 2026-11-01): Immich lets only an admin point the server at a host (machine learning, OAuth), and workflow plugins
// only at the hosts they declare.

const internal = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  internal.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127],
  // NAT64 and 6to4 carry an IPv4 address inside, which may be a private one.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  internal.addSubnet(address, prefix, 'ipv6');
}

export const isInternalAddress = (address: string) => internal.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** Why the server would not call this URL, or null; a host that does not resolve is left to the call. */
export const llmUrlRefusal = async (value: string): Promise<string | null> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'The LLM server URL is not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The LLM server URL must start with https:// or http://';
  }
  const host = url.hostname.replaceAll(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    const found = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    addresses = found.map(({ address }) => address);
  } catch {
    return null;
  }
  return addresses.some((address) => isInternalAddress(address))
    ? `The LLM server ${url.hostname} is inside the server's network`
    : null;
};
