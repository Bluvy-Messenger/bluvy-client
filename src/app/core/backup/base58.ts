const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CHAR_MAP = new Map<string, bigint>(
  [...ALPHABET].map((c, i) => [c, BigInt(i)]),
);

export function base58Encode(bytes: Uint8Array): string {
  let leadingOnes = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    leadingOnes++;
  }
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(leadingOnes) + out;
}

export function base58Decode(str: string): Uint8Array {
  let leadingZeros = 0;
  for (const c of str) {
    if (c !== '1') break;
    leadingZeros++;
  }
  let n = 0n;
  for (const c of str) {
    const v = CHAR_MAP.get(c);
    if (v === undefined) throw new Error(`Invalid Base58 character: "${c}"`);
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...bytes]);
}
