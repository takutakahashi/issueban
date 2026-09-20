const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(value: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value));
  return { ciphertext: btoa(String.fromCharCode(...new Uint8Array(data))), iv: btoa(String.fromCharCode(...iv)) };
}

export async function decrypt(ciphertext: string, iv: string, secret: string): Promise<string> {
  const data = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
  const ivBytes = Uint8Array.from(atob(iv), (char) => char.charCodeAt(0));
  const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, await encryptionKey(secret), data);
  return new TextDecoder().decode(result);
}
