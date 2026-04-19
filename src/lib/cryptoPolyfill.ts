import 'react-native-get-random-values';
import * as ExpoCrypto from 'expo-crypto';

const algoMap: Record<string, ExpoCrypto.CryptoDigestAlgorithm> = {
  'SHA-1': ExpoCrypto.CryptoDigestAlgorithm.SHA1,
  'SHA-256': ExpoCrypto.CryptoDigestAlgorithm.SHA256,
  'SHA-384': ExpoCrypto.CryptoDigestAlgorithm.SHA384,
  'SHA-512': ExpoCrypto.CryptoDigestAlgorithm.SHA512,
};

const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (!g.crypto.subtle) {
  g.crypto.subtle = {
    digest: async (
      algorithm: string | { name: string },
      data: ArrayBuffer | ArrayBufferView,
    ): Promise<ArrayBuffer> => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const expoAlgo = algoMap[name];
      if (!expoAlgo) throw new Error(`Unsupported digest algorithm: ${name}`);
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return ExpoCrypto.digest(expoAlgo, bytes as unknown as ArrayBuffer);
    },
  };
}
