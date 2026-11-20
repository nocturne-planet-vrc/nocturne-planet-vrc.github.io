export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const nowIso = () => new Date().toISOString();
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function fromBase64(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
export function text(value, max = 200, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new HttpError(400, '入力内容を確認してください。', 'INVALID_INPUT');
  return value.trim();
}
export function snowflake(value) {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value))
    throw new HttpError(400, 'Discord IDが正しくありません。');
  return value;
}
export function httpsUrl(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(text(value, 2048));
  } catch {
    throw new HttpError(400, 'URLを確認してください。');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new HttpError(400, 'httpsのURLを指定してください。');
  return url.href;
}
export function iso(value, optional = false) {
  if (optional && !value) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new HttpError(400, '日時を確認してください。');
  return new Date(value).toISOString();
}
export function isAdmin(member, env) {
  const allowed = String(env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return !!member && allowed.length > 0 && Array.isArray(member.roles) && member.roles.some(id => allowed.includes(id));
}
export function imageType(bytes) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  throw new HttpError(400, 'JPEG・PNG・WebPの画像を選んでください。', 'INVALID_IMAGE');
}
export function checkinWindow(event, time = Date.now()) {
  return (
    !!event?.published &&
    !event.deleted_at &&
    !!event.checkin_hash &&
    !!event.checkin_opens_at &&
    !!event.checkin_closes_at &&
    time >= Date.parse(event.checkin_opens_at) &&
    time <= Date.parse(event.checkin_closes_at)
  );
}
export async function passphraseHash(eventId, salt, passphrase, pepper) {
  if (!pepper || pepper.length < 24) throw new HttpError(503, 'チェックインの準備中です。');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${eventId}\0${salt}\0${passphrase.normalize('NFKC').trim()}`)
      )
    )
  );
}
export async function seal(value, keyString) {
  const raw = fromBase64(keyString || '');
  if (raw.length !== 32) throw new HttpError(503, '認証の準備中です。');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function unseal(value, keyString) {
  const [iv, data] = value.split('.');
  const key = await crypto.subtle.importKey('raw', fromBase64(keyString), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(data))
    )
  );
}
export async function limitedBytes(request, maxBytes) {
  if (Number(request.headers.get('Content-Length')) > maxBytes)
    throw new HttpError(413, '送信するデータが大きすぎます。');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(),
    chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, '送信するデータが大きすぎます。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function formBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('multipart/form-data;')) throw new HttpError(400, '画像の送信内容を確認してください。');
  const bytes = await limitedBytes(request, 4500000);
  try {
    return await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new HttpError(400, '画像の送信内容を確認してください。');
  }
}
export async function bodyJson(request, limit = 180000) {
  const raw = new TextDecoder().decode(await limitedBytes(request, limit * 4));
  if (raw.length > limit) throw new HttpError(413, '入力内容が大きすぎます。');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw 0;
    return body;
  } catch {
    throw new HttpError(400, '入力内容を確認してください。');
  }
}
export async function rateLimit(db, key, max, windowSeconds = 60) {
  const now = Math.floor(Date.now() / 1000),
    bucket = Math.floor(now / windowSeconds),
    name = `${key}:${bucket}`;
  const result = await db
    .prepare(
      'INSERT INTO rate_limits(key,count,resets_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count'
    )
    .bind(name, now + windowSeconds)
    .first();
  if (result.count > max) throw new HttpError(429, '少し時間を置いてから、もう一度お試しください。', 'RATE_LIMIT');
}
