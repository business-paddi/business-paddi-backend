import net from 'node:net';

const nonPublicAddresses = new net.BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv6');
}

export function normalizeIpAddress(value: string | null): string | null {
  if (!value) {
    return null;
  }

  let address = value.trim();

  if (address.toLowerCase().startsWith('::ffff:')) {
    address = address.slice(7);
  }

  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) {
    address = address.slice(0, zoneIndex);
  }

  return net.isIP(address) ? address : null;
}

export function isPrivateIpAddress(value: string): boolean {
  const address = normalizeIpAddress(value);

  if (!address) {
    return false;
  }

  const family = net.isIP(address) === 4 ? 'ipv4' : 'ipv6';
  return nonPublicAddresses.check(address, family);
}
