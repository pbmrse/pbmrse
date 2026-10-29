const encoder = new TextEncoder();
const MAX_CLOCK_SKEW_MS = 60_000;

export type SignerAudience = 'pbmrse-treasury-signer:v1' | 'pbmrse-reward-signer:v1' | 'pbmrse-custody-signer:v1';

export function validSignerCallerSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && /^[0-9a-fA-F]{64,128}$/.test(secret);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function bodyHash(body: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function canonicalRequest(
  audience: SignerAudience,
  method: string,
  pathname: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return [audience, method.toUpperCase(), pathname, timestamp, await bodyHash(body)].join('\n');
}

export async function authenticatedSignerRequest(
  url: string,
  body: string,
  secret: string,
  audience: SignerAudience,
  now = Date.now(),
): Promise<Request> {
  if (!validSignerCallerSecret(secret)) throw new Error('SIGNER_CALLER_SECRET_INVALID');
  const parsed = new URL(url);
  const timestamp = String(now);
  const canonical = await canonicalRequest(audience, 'POST', parsed.pathname, timestamp, body);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(canonical))));
  return new Request(parsed, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PBM-Signer-Timestamp': timestamp,
      'X-PBM-Signer-Signature': signature,
    },
    body,
  });
}

export async function verifySignerCaller(
  request: Request,
  body: string,
  secret: string | undefined,
  audience: SignerAudience,
  now = Date.now(),
): Promise<boolean> {
  if (!validSignerCallerSecret(secret)) return false;
  const timestamp = request.headers.get('X-PBM-Signer-Timestamp');
  const signature = request.headers.get('X-PBM-Signer-Signature');
  if (!timestamp || !/^[0-9]{13}$/.test(timestamp) || !signature) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > MAX_CLOCK_SKEW_MS) return false;
  const signatureBytes = hexToBytes(signature);
  if (!signatureBytes) return false;
  const canonical = await canonicalRequest(audience, request.method, new URL(request.url).pathname, timestamp, body);
  const signatureBuffer = new ArrayBuffer(signatureBytes.byteLength);
  new Uint8Array(signatureBuffer).set(signatureBytes);
  return crypto.subtle.verify('HMAC', await hmacKey(secret), signatureBuffer, encoder.encode(canonical));
}
