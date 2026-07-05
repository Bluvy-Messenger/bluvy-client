import { base58Decode, base58Encode } from './base58';

describe('base58Encode', () => {
  it('returns a non-empty string for non-zero bytes', () => {
    const result = base58Encode(new Uint8Array([1, 2, 3, 4]));
    expect(result.length).toBeGreaterThan(0);
  });

  it('encodes leading zero bytes as leading "1"s', () => {
    const result = base58Encode(new Uint8Array([0, 0, 1]));
    expect(result.startsWith('11')).toBeTrue();
  });

  it('produces only Base58 alphabet characters', () => {
    const ALPHABET = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    const result = base58Encode(new Uint8Array([10, 20, 30, 40, 50]));
    expect(ALPHABET.test(result)).toBeTrue();
  });
});

describe('base58Decode', () => {
  it('roundtrips correctly for arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 128, 200, 255]);
    expect(base58Decode(base58Encode(original))).toEqual(original);
  });

  it('roundtrips a 32-byte random-like buffer', () => {
    const original = new Uint8Array(32).map((_, i) => (i * 37 + 13) % 256);
    expect(base58Decode(base58Encode(original))).toEqual(original);
  });

  it('roundtrips a single-byte value', () => {
    const original = new Uint8Array([42]);
    expect(base58Decode(base58Encode(original))).toEqual(original);
  });

  it('throws on an invalid character', () => {
    expect(() => base58Decode('0')).toThrowError(/Invalid Base58/);
  });

  it('throws on character "O" (not in alphabet)', () => {
    expect(() => base58Decode('O')).toThrowError(/Invalid Base58/);
  });
});
