import { createHash, createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';

export interface SealedData {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: number;
}

/**
 * Resolve the TEE instance ID from available sources.
 * Priority order (from KNOWLEDGE_EXTRACTION.md):
 *   1. /mnt/secure/self_report.txt — SHA256 of content (first 32 chars)
 *   2. /mnt/secure/tdx_attestation.txt — SHA256 of content
 *   3. /sys/kernel/config/tsm/report/outblob — SHA256 of content
 *   4. DEV_MODE fallback: hostname + persistent seed at /tmp/.idiostasis-dev-seed
 */
export async function resolveTeeInstanceId(): Promise<string> {
  const teePaths = [
    '/mnt/secure/self_report.txt',
    '/mnt/secure/tdx_attestation.txt',
    '/sys/kernel/config/tsm/report/outblob',
  ];

  for (const path of teePaths) {
    try {
      const content = await readFile(path);
      return createHash('sha256').update(content).digest('hex').slice(0, 32);
    } catch {
      continue;
    }
  }

  // Dev mode fallback — hostname + persistent random seed
  console.warn('[vault] no TEE identity source found — using dev fallback');
  const seedPath = '/tmp/.idiostasis-dev-seed';
  let seed: string;
  try {
    seed = (await readFile(seedPath, 'utf-8')).trim();
  } catch {
    seed = randomBytes(32).toString('hex');
    try {
      await writeFile(seedPath, seed, 'utf-8');
    } catch {
      // Can't persist seed — ephemeral identity
    }
  }
  return createHash('sha256').update(`${hostname()}|${seed}`).digest('hex').slice(0, 32);
}

/**
 * Resolve this VM's SecretVM domain at runtime.
 *
 * Priority:
 *   1. SECRETVM_DOMAIN env var (explicit override)
 *   2. Parse CN from /mnt/secure/cert/secret_vm_cert.pem
 *   3. /mnt/secure/self_report.txt — look for "domain:" or "vmDomain:" field
 *   4. Dev fallback: "localhost"
 */
export async function resolveSecretvmDomain(): Promise<string> {
  // 1. Explicit env var override
  const envDomain = process.env.SECRETVM_DOMAIN;
  if (envDomain) return envDomain;

  // 2. Parse CN from the VM's SSL certificate
  try {
    const cert = await readFile('/mnt/secure/cert/secret_vm_cert.pem');
    const x509 = new X509Certificate(cert);
    const cn = x509.subject.match(/CN=([^\n,]+)/)?.[1];
    if (cn) return cn;
  } catch { /* cert not available */ }

  // 3. Try self_report.txt for domain field
  try {
    const report = await readFile('/mnt/secure/self_report.txt', 'utf-8');
    const match = report.match(/(?:vmDomain|domain):\s*([a-z0-9-]+\.vm\.scrtlabs\.com)/i);
    if (match?.[1]) return match[1];
  } catch { /* not available */ }

  // 4. Dev fallback
  console.warn('[tee] could not resolve SecretVM domain — using localhost');
  return 'localhost';
}

/**
 * Derive sealing key from teeInstanceId (Decision 1).
 * SHA256("idiostasis-vault-seal-v1|{teeInstanceId}")
 */
export async function deriveSealingKey(teeInstanceId?: string): Promise<Uint8Array> {
  const id = teeInstanceId ?? await resolveTeeInstanceId();
  return new Uint8Array(
    createHash('sha256').update(`idiostasis-vault-seal-v1|${id}`).digest()
  );
}

/**
 * Seal data with AES-256-GCM using provided sealing key.
 * Returns sealed payload with base64 ciphertext, hex IV and authTag, version=1.
 */
export function sealData(data: Uint8Array, sealingKey: Uint8Array): SealedData {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    version: 1,
  };
}

/**
 * Unseal data encrypted by sealData.
 */
export function unsealData(sealed: SealedData, sealingKey: Uint8Array): Uint8Array {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    sealingKey,
    Buffer.from(sealed.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return new Uint8Array(decrypted);
}
