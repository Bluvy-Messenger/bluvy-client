import { ed25519, x25519 } from '@noble/curves/ed25519.js';

// Define FakeCryptoKey class
class FakeCryptoKey implements CryptoKey {
  readonly type: 'public' | 'private';
  readonly extractable: boolean;
  readonly algorithm: KeyAlgorithm;
  readonly usages: KeyUsage[];
  readonly rawKeyBytes: Uint8Array;

  constructor(
    type: 'public' | 'private',
    algorithm: KeyAlgorithm,
    extractable: boolean,
    usages: KeyUsage[],
    rawKeyBytes: Uint8Array
  ) {
    this.type = type;
    this.algorithm = algorithm;
    this.extractable = extractable;
    this.usages = usages;
    this.rawKeyBytes = rawKeyBytes;
  }
}

// Intercept window.CryptoKey instanceof check
if (typeof window !== 'undefined' && (window as any).CryptoKey) {
  const originalHasInstance = (window as any).CryptoKey[Symbol.hasInstance];
  Object.defineProperty((window as any).CryptoKey, Symbol.hasInstance, {
    value: function (instance: any) {
      if (instance && instance.constructor === FakeCryptoKey) return true;
      return originalHasInstance ? originalHasInstance.call(this, instance) : (instance instanceof FakeCryptoKey);
    },
    writable: true,
    configurable: true
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// PKCS#8 utilities to handle PKCS#8 export/import of Ed25519 and X25519
function rawEd25519ToPKCS8(rawKey: Uint8Array): Uint8Array {
  const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const innerOctet = new Uint8Array([0x04, 0x20, ...rawKey]);
  const privateKeyField = new Uint8Array([0x04, 0x22, ...innerOctet]);
  const algSeq = new Uint8Array([0x30, 0x05, ...oid]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const content = new Uint8Array([...version, ...algSeq, ...privateKeyField]);
  return new Uint8Array([0x30, content.length, ...content]);
}

function rawX25519ToPKCS8(rawKey: Uint8Array): Uint8Array {
  const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x6e]);
  const innerOctet = new Uint8Array([0x04, 0x20, ...rawKey]);
  const privateKeyField = new Uint8Array([0x04, 0x22, ...innerOctet]);
  const algSeq = new Uint8Array([0x30, 0x05, ...oid]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const content = new Uint8Array([...version, ...algSeq, ...privateKeyField]);
  return new Uint8Array([0x30, content.length, ...content]);
}

// Monkey-patch global crypto.subtle
if (typeof crypto !== 'undefined' && crypto.subtle) {
  const nativeGenerateKey = crypto.subtle.generateKey;
  const nativeImportKey   = crypto.subtle.importKey;
  const nativeExportKey   = crypto.subtle.exportKey;
  const nativeSign        = crypto.subtle.sign;
  const nativeVerify      = crypto.subtle.verify;
  const nativeDeriveBits  = crypto.subtle.deriveBits;

  const getAlgorithmName = (alg: any): string => {
    if (typeof alg === 'string') return alg;
    return alg?.name || '';
  };

  const isSupportedAlgorithm = (name: string): boolean => {
    return name === 'Ed25519' || name === 'X25519';
  };

  (crypto.subtle as any).generateKey = async function (algorithm: any, extractable: boolean, keyUsages: any): Promise<any> {
    const name = getAlgorithmName(algorithm);
    if (isSupportedAlgorithm(name)) {
      if (name === 'Ed25519') {
        const privBytes = ed25519.utils.randomSecretKey();
        const pubBytes = ed25519.getPublicKey(privBytes);
        return {
          privateKey: new FakeCryptoKey('private', { name: 'Ed25519' }, extractable, keyUsages, privBytes),
          publicKey: new FakeCryptoKey('public', { name: 'Ed25519' }, true, keyUsages, pubBytes)
        };
      } else {
        const privBytes = x25519.utils.randomSecretKey();
        const pubBytes = x25519.getPublicKey(privBytes);
        return {
          privateKey: new FakeCryptoKey('private', { name: 'X25519' }, extractable, keyUsages, privBytes),
          publicKey: new FakeCryptoKey('public', { name: 'X25519' }, true, keyUsages, pubBytes)
        };
      }
    }
    return nativeGenerateKey.call(crypto.subtle, algorithm, extractable, keyUsages);
  };

  (crypto.subtle as any).importKey = async function (
    format: any,
    keyData: any,
    algorithm: any,
    extractable: boolean,
    keyUsages: any
  ): Promise<any> {
    const name = getAlgorithmName(algorithm);
    if (isSupportedAlgorithm(name)) {
      let rawBytes: Uint8Array;
      let type: 'public' | 'private' = 'public';

      if (format === 'raw') {
        rawBytes = new Uint8Array(keyData as ArrayBuffer);
        type = 'public';
      } else if (format === 'pkcs8') {
        const fullBytes = new Uint8Array(keyData as ArrayBuffer);
        rawBytes = fullBytes.slice(-32);
        type = 'private';
      } else if (format === 'jwk') {
        if (keyData.d) {
          rawBytes = base64UrlDecode(keyData.d);
          type = 'private';
        } else {
          rawBytes = base64UrlDecode(keyData.x);
          type = 'public';
        }
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      return new FakeCryptoKey(type, { name }, extractable, keyUsages, rawBytes);
    }
    return nativeImportKey.call(crypto.subtle, format, keyData, algorithm, extractable, keyUsages);
  };

  (crypto.subtle as any).exportKey = async function (format: any, key: any): Promise<any> {
    if (key instanceof FakeCryptoKey) {
      if (format === 'raw') {
        return key.rawKeyBytes.buffer;
      } else if (format === 'pkcs8') {
        if (key.type !== 'private') throw new Error('Cannot export public key as pkcs8');
        const pkcs8 = key.algorithm.name === 'Ed25519'
          ? rawEd25519ToPKCS8(key.rawKeyBytes)
          : rawX25519ToPKCS8(key.rawKeyBytes);
        return pkcs8.buffer;
      } else if (format === 'jwk') {
        const jwk: any = {
          kty: 'OKP',
          crv: key.algorithm.name,
          x: base64UrlEncode(key.type === 'private'
            ? (key.algorithm.name === 'Ed25519' ? ed25519.getPublicKey(key.rawKeyBytes) : x25519.getPublicKey(key.rawKeyBytes))
            : key.rawKeyBytes
          )
        };
        if (key.type === 'private') {
          jwk.d = base64UrlEncode(key.rawKeyBytes);
        }
        return jwk;
      }
      throw new Error(`Unsupported format: ${format}`);
    }
    return nativeExportKey.call(crypto.subtle, format, key);
  };

  (crypto.subtle as any).sign = async function (algorithm: any, key: any, data: any): Promise<any> {
    const name = getAlgorithmName(algorithm);
    if (name === 'Ed25519' && key instanceof FakeCryptoKey) {
      const message = new Uint8Array(data as ArrayBuffer);
      const signature = ed25519.sign(message, key.rawKeyBytes);
      return signature.buffer;
    }
    return nativeSign.call(crypto.subtle, algorithm, key, data);
  };

  (crypto.subtle as any).verify = async function (algorithm: any, key: any, signature: any, data: any): Promise<any> {
    const name = getAlgorithmName(algorithm);
    if (name === 'Ed25519' && key instanceof FakeCryptoKey) {
      const sigBytes = new Uint8Array(signature as ArrayBuffer);
      const msgBytes = new Uint8Array(data as ArrayBuffer);
      return ed25519.verify(sigBytes, msgBytes, key.rawKeyBytes);
    }
    return nativeVerify.call(crypto.subtle, algorithm, key, signature, data);
  };

  (crypto.subtle as any).deriveBits = async function (algorithm: any, baseKey: any, length: any): Promise<any> {
    const name = getAlgorithmName(algorithm);
    if (name === 'X25519') {
      const sk = (baseKey as FakeCryptoKey).rawKeyBytes;
      const pk = (algorithm.public as FakeCryptoKey).rawKeyBytes;
      const shared = x25519.getSharedSecret(sk, pk);
      return shared.buffer;
    }
    return nativeDeriveBits.call(crypto.subtle, algorithm, baseKey, length);
  };
}
