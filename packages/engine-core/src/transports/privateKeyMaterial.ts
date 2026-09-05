import { readFile } from 'node:fs/promises';
import type { BaseTransportConfig } from './types.js';

/**
 * Resolves the private-key bytes ssh2 needs. A config carries either
 * in-memory `privateKey` bytes (a vault-credential adapter running while
 * the vault is unlocked) or a `privateKeyPath` on disk (a transport-backed
 * adapter). ssh2 / ssh2-sftp-client accept the bytes directly either way.
 */
export async function resolvePrivateKeyMaterial(
  config: Pick<BaseTransportConfig, 'privateKey' | 'privateKeyPath'>
): Promise<Buffer> {
  if (config.privateKey) return config.privateKey;
  if (config.privateKeyPath) return readFile(config.privateKeyPath);
  throw new Error('No private key material: supply privateKey (bytes) or privateKeyPath.');
}
