import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// A user's LLM key is stored encrypted with a secret from the environment (trips ADR 0003).

export const TRIPS_LLM_SECRET_VARIABLE = 'TRIPS_LLM_SECRET';

export enum TripLlmKeyState {
  None = 'none',
  Set = 'set',
  // The secret is missing or changed since the key was saved: the user enters it again.
  Unreadable = 'unreadable',
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyOf = (secret: string) => Buffer.from(hkdfSync('sha256', secret, '', 'gallery trips llm key', 32));

/** The secret, or nothing when `TRIPS_LLM_SECRET` is unset or blank. */
export const resolveLlmSecret = (env: NodeJS.ProcessEnv = process.env) =>
  env[TRIPS_LLM_SECRET_VARIABLE]?.trim() || undefined;

/** `v1:<base64 of IV, tag and AES-256-GCM ciphertext>`. */
export const encryptLlmKey = (key: string, secret: string) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const text = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), text]).toString('base64')}`;
};

/** The key, or null when this secret cannot read the cipher. */
export const decryptLlmKey = (value: string, secret: string): string | null => {
  const [version, body] = value.split(':', 2);
  if (version !== VERSION || !body) {
    return null;
  }
  const data = Buffer.from(body, 'base64');
  if (data.length <= IV_BYTES + TAG_BYTES) {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};

export const tripLlmKeyState = (keyCipher: string | null, secret: string | undefined) => {
  if (!keyCipher) {
    return TripLlmKeyState.None;
  }
  return secret && decryptLlmKey(keyCipher, secret) !== null ? TripLlmKeyState.Set : TripLlmKeyState.Unreadable;
};

/**
 * The cipher to save: a sent key replaces the old one, null clears it, and an unsent key is kept only while the URL
 * stays, so a key is never sent to a server it was not entered for (travel-album intent, stage 9). A kept key this
 * secret cannot read is dropped, so the settings stop reporting it.
 */
export const nextLlmKeyCipher = (
  previous: { url: string; keyCipher: string | null } | undefined,
  update: { url: string; key?: string | null },
  secret: string | undefined,
): string | null => {
  if (update.key === null) {
    return null;
  }
  if (update.key === undefined) {
    const isKept = previous?.url === update.url && tripLlmKeyState(previous.keyCipher, secret) === TripLlmKeyState.Set;
    return isKept ? previous.keyCipher : null;
  }
  if (!secret) {
    throw new BadRequestException(`Set ${TRIPS_LLM_SECRET_VARIABLE} on the server to save an LLM key`);
  }
  return encryptLlmKey(update.key, secret);
};
