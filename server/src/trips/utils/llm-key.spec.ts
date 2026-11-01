import { describe, expect, it } from 'vitest';
import {
  TripLlmKeyState,
  decryptLlmKey,
  encryptLlmKey,
  nextLlmKeyCipher,
  resolveLlmSecret,
  tripLlmKeyState,
} from 'src/trips/utils/llm-key.js';

const SECRET = 'a-secret-from-the-compose-file';

describe(encryptLlmKey.name, () => {
  it('round-trips a key through the secret', () => {
    const cipher = encryptLlmKey('sk-123', SECRET);
    expect(cipher).not.toContain('sk-123');
    expect(decryptLlmKey(cipher, SECRET)).toBe('sk-123');
  });

  it('gives a new cipher every time', () => {
    expect(encryptLlmKey('sk-123', SECRET)).not.toBe(encryptLlmKey('sk-123', SECRET));
  });

  it('reads nothing with another secret or a damaged cipher', () => {
    const cipher = encryptLlmKey('sk-123', SECRET);
    expect(decryptLlmKey(cipher, 'another-secret')).toBeNull();
    expect(decryptLlmKey(cipher.slice(0, -4) + 'AAAA', SECRET)).toBeNull();
    expect(decryptLlmKey('garbage', SECRET)).toBeNull();
  });
});

describe(resolveLlmSecret.name, () => {
  it('reads TRIPS_LLM_SECRET, and nothing when it is unset or blank', () => {
    expect(resolveLlmSecret({ TRIPS_LLM_SECRET: ' s ' })).toBe('s');
    expect(resolveLlmSecret({ TRIPS_LLM_SECRET: '  ' })).toBeUndefined();
    expect(resolveLlmSecret({})).toBeUndefined();
  });
});

describe(tripLlmKeyState.name, () => {
  it('tells a missing key from one the secret cannot read', () => {
    const cipher = encryptLlmKey('sk-123', SECRET);
    expect(tripLlmKeyState(null, SECRET)).toBe(TripLlmKeyState.None);
    expect(tripLlmKeyState(cipher, SECRET)).toBe(TripLlmKeyState.Set);
    expect(tripLlmKeyState(cipher, 'another-secret')).toBe(TripLlmKeyState.Unreadable);
    expect(tripLlmKeyState(cipher, undefined)).toBe(TripLlmKeyState.Unreadable);
  });
});

describe(nextLlmKeyCipher.name, () => {
  const previous = { url: 'https://api.openai.com/v1', keyCipher: encryptLlmKey('sk-old', SECRET) };

  it('keeps the saved key when none is sent and the URL stays', () => {
    expect(nextLlmKeyCipher(previous, { url: 'https://api.openai.com/v1' }, SECRET)).toBe(previous.keyCipher);
  });

  it('drops the saved key when the URL changes, so it never goes to another server', () => {
    expect(nextLlmKeyCipher(previous, { url: 'https://openrouter.ai/api/v1' }, SECRET)).toBeNull();
  });

  it('stores a sent key, also with a new URL', () => {
    const cipher = nextLlmKeyCipher(previous, { url: 'https://openrouter.ai/api/v1', key: 'sk-new' }, SECRET);
    expect(decryptLlmKey(cipher!, SECRET)).toBe('sk-new');
  });

  it('clears the key on null', () => {
    expect(nextLlmKeyCipher(previous, { url: previous.url, key: null }, SECRET)).toBeNull();
  });

  it('refuses to store a key without the secret', () => {
    expect(() => nextLlmKeyCipher(undefined, { url: previous.url, key: 'sk-new' }, undefined)).toThrow(
      'TRIPS_LLM_SECRET',
    );
  });
});
