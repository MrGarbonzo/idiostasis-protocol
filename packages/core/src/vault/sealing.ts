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
const TEE_INSTANCE_ID_PATH = '/data/tee-instance-id';

export async function resolveTeeInstanceId(): Promise<string> {
  // 0. Check persistent storage first — stable across restarts
  try {
    const stored = await readFile(TEE_INSTANCE_ID_PATH, 'utf-8');
    const id = stored.trim();
    if (id && id.length === 32) return id;
  } catch { /* not stored yet */ }

  // 1-3. Derive from TEE sources
  const teePaths = [
    '/mnt/secure/self_report.txt',
    '/mnt/secure/tdx_attestation.txt',
    '/sys/kernel/config/tsm/report/outblob',
  ];

  let id: string | null = null;

  for (const path of teePaths) {
    try {
      const content = await readFile(path);
      id = createHash('sha256').update(content).digest('hex').slice(0, 32);
      break;
    } catch {
      continue;
    }
  }

  if (!id) {
    // Dev fallback — hostname + persistent seed
    console.warn('[vault] no TEE identity source found — using dev fallback');
    const seedPath = '/tmp/.idiostasis-dev-seed';
    let seed: string;
    try {
      seed = (await readFile(seedPath, 'utf-8')).trim();
    } catch {
      seed = randomBytes(32).toString('hex');
      try {
        await writeFile(seedPath, seed, 'utf-8');
      } catch { /* ephemeral */ }
    }
    id = createHash('sha256')
      .update(`${hostname()}|${seed}`)
      .digest('hex')
      .slice(0, 32);
  }

  // Persist for future restarts
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir('/data', { recursive: true });
    await writeFile(TEE_INSTANCE_ID_PATH, id, 'utf-8');
  } catch { /* non-fatal */ }

  return id;
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

  // 2. Try TLS cert from SecretVM attestation server (port 29343)
  const tlsDomain = await resolveSecretvmDomainFromTls();
  if (tlsDomain) return tlsDomain;

  // 3. Parse CN from the VM's SSL certificate file
  try {
    const cert = await readFile('/mnt/secure/cert/secret_vm_cert.pem');
    const x509 = new X509Certificate(cert);
    const cn = x509.subject.match(/CN=([^\n,]+)/)?.[1];
    if (cn) return cn;
  } catch { /* cert not available */ }

  // 4. Try self_report.txt for domain field
  try {
    const report = await readFile('/mnt/secure/self_report.txt', 'utf-8');
    const match = report.match(/(?:vmDomain|domain):\s*([a-z0-9-]+\.vm\.scrtlabs\.com)/i);
    if (match?.[1]) return match[1];
  } catch { /* not available */ }

  // 5. Dev fallback
  console.warn('[tee] could not resolve SecretVM domain — using localhost');
  return 'localhost';
}

/**
 * Resolve SecretVM domain by connecting to the attestation server TLS cert.
 * Works from inside Docker containers via host gateway (172.17.0.1).
 * Returns the CN if it matches *.vm.scrtlabs.com, null otherwise.
 */
export async function resolveSecretvmDomainFromTls(): Promise<string | null> {
  return new Promise((resolve) => {
    import('node:tls').then(tls => {
      const socket = tls.connect(
        { host: '172.17.0.1', port: 29343, rejectUnauthorized: false },
        () => {
          try {
            const cert = socket.getPeerCertificate();
            const rawCn = cert?.subject?.CN ?? null;
            const cn = Array.isArray(rawCn) ? rawCn[0] : rawCn;
            socket.destroy();
            resolve(cn?.endsWith('.vm.scrtlabs.com') ? cn : null);
          } catch {
            socket.destroy();
            resolve(null);
          }
        }
      );
      socket.on('error', () => resolve(null));
      socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
    });
  });
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
