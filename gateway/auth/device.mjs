import { createHash, createPublicKey, verify } from 'node:crypto';

export const DEVICE_SIGNATURE_ALGORITHM = 'ECDSA-P256-SHA256';
export const DEVICE_PAYLOAD_VERSION = 'TIDE-DEVICE-V1';

export function normalizeFingerprint(value) {
  const fingerprint = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('key_fingerprint 必须是 64 位 SHA-256 hex');
  }
  return fingerprint;
}

export function decodePublicKey(publicKeyBase64) {
  if (typeof publicKeyBase64 !== 'string' || !publicKeyBase64.trim()) {
    throw new Error('device_public_key 必填');
  }
  const der = Buffer.from(publicKeyBase64.trim(), 'base64');
  if (!der.length || der.length > 4096) throw new Error('device_public_key 长度不合法');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec') throw new Error('设备公钥必须是 EC P-256');
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('设备公钥必须使用 P-256');
  }
  return { key, der };
}

export function fingerprintPublicKey(publicKeyBase64) {
  const { der } = decodePublicKey(publicKeyBase64);
  return createHash('sha256').update(der).digest('hex');
}

export function verifyDeviceSignature({ publicKey, payload, signature }) {
  let parsed;
  try {
    parsed = decodePublicKey(publicKey);
  } catch (error) {
    throw new Error(`设备公钥无效: ${error.message}`);
  }
  if (typeof signature !== 'string' || !signature.trim()) throw new Error('设备签名必填');
  const sig = Buffer.from(signature.trim(), 'base64');
  if (!sig.length || sig.length > 1024) throw new Error('设备签名长度不合法');
  return verify(
    'sha256',
    Buffer.from(String(payload || ''), 'utf8'),
    parsed.key,
    sig,
  );
}

export function buildDevicePayload({ challengeId, username, keyFingerprint, purpose, nonce }) {
  return [
    DEVICE_PAYLOAD_VERSION,
    challengeId,
    username,
    keyFingerprint,
    purpose,
    nonce,
  ].join('\n');
}
