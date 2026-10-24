const HEXTET = /^[0-9a-f]{1,4}$/;
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * Key to limit a client by IP. IPv4 stays as is (and so does IPv4-mapped IPv6); IPv6 is cut to its /64, because one
 * subscriber gets a whole /64 and could otherwise rotate addresses to dodge every per-IP limit.
 * Anything that does not parse is returned unchanged.
 */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const lower = ip.toLowerCase();
  const mapped = MAPPED_V4.exec(lower);
  if (mapped) return mapped[1]!;

  const halves = lower.split("::");
  if (halves.length > 2) return ip;
  const parts = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parts(halves[0]!);
  const tail = halves.length === 2 ? parts(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return ip;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => HEXTET.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
