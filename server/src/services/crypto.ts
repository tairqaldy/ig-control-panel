/**
 * Symmetric encryption for secrets stored at rest (Instagram OAuth tokens, Companion sessions).
 * AES-256-GCM; key = sha256(`${SESSION_SECRET}:${purpose}`) — the default purpose 'ig' matches the round-5 spec.
 * Wire format: `enc1.<iv b64url>.<ciphertext b64url>.<tag b64url>`. Rotating SESSION_SECRET invalidates stored secrets
 * (they simply fail to decrypt → treated as missing), which is the intended behaviour.
 *
 * Shared by the server-instagram and server-companion work — do not duplicate.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc1';
const keyCache = new Map<string, Buffer>();

function keyFor(purpose: string): Buffer {
  let k = keyCache.get(purpose);
  if (!k) {
    k = crypto.createHash('sha256').update(`${config.sessionSecret}:${purpose}`).digest();
    keyCache.set(purpose, k);
  }
  return k;
}

/** Encrypt a UTF-8 string. Never throws for string input. */
export function encryptSecret(plain: string, purpose = 'ig'): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}

/** Decrypt a value produced by `encryptSecret`. Throws on a malformed/tampered value or a wrong key. */
export function decryptSecret(enc: string, purpose = 'ig'): string {
  const parts = String(enc || '').split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('not an encrypted secret');
  const [, ivB, ctB, tagB] = parts;
  const iv = Buffer.from(ivB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when the value looks like something `encryptSecret` produced. */
export function isEncryptedSecret(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.startsWith(`${PREFIX}.`) && v.split('.').length === 4;
}

/** Decrypt or return null (wrong key, tampered, empty). */
export function tryDecryptSecret(enc: string | null | undefined, purpose = 'ig'): string | null {
  if (!enc) return null;
  try { return decryptSecret(enc, purpose); } catch { return null; }
}
