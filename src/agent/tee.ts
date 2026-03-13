/**
 * TEE Instance ID — extract hardware-bound identity from Intel TDX.
 *
 * On SecretVM (Intel TDX), the TEE instance is identified by:
 *   - MRTD: Measurement of the TD (initial code/config hash)
 *   - RTMR[0-3]: Runtime measurements (can extend with runtime events)
 *
 * These registers are hardware-bound and cannot be copied or forged.
 * A different VM instance will have different RTMR values even with
 * identical code, making each instance uniquely identifiable.
 *
 * In development, we fall back to a machine-specific identifier.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';

/** TEE identity containing hardware measurements. */
export interface TEEIdentity {
  /** Unique instance ID derived from TDX registers or machine identity. */
  instanceId: string;
  /** Whether this is a real TDX attestation or a dev fallback. */
  isTDX: boolean;
  /** SHA-256 of the running code/container image. */
  codeHash: string;
}

/** Path to TDX guest device (Linux kernel ≥ 6.2). */
const TDX_GUEST_DEVICE = '/dev/tdx_guest';
/** Path to TDX report (via configfs-tsm). */
const TDX_REPORT_PATH = '/sys/kernel/config/tsm/report';
/** SecretVM self_report.txt with RTMR values. */
const SECRETVM_SELF_REPORT_PATH = '/mnt/secure/self_report.txt';
/** SecretVM full attestation quote. */
const SECRETVM_TDX_ATTESTATION_PATH = '/mnt/secure/tdx_attestation.txt';
/** Fallback: SecretVM attestation endpoint. */
const SECRETVM_ATTESTATION_URL = 'http://169.254.169.254/attestation';

/**
 * Get the TEE instance ID.
 *
 * Priority:
 *   1. Intel TDX via /dev/tdx_guest or configfs-tsm
 *   2. SecretVM attestation API
 *   3. Development fallback (hostname + random seed persisted to disk)
 */
export async function getTEEInstanceId(): Promise<TEEIdentity> {
  const codeHash = getCodeHash();

  // Try SecretVM self_report.txt (contains MRTD + RTMR values as text)
  if (existsSync(SECRETVM_SELF_REPORT_PATH)) {
    try {
      const report = readFileSync(SECRETVM_SELF_REPORT_PATH, 'utf-8');
      const instanceId = createHash('sha256').update(report).digest('hex').slice(0, 32);
      return { instanceId, isTDX: true, codeHash };
    } catch {
      // Fall through
    }
  }

  // Try SecretVM full attestation quote
  if (existsSync(SECRETVM_TDX_ATTESTATION_PATH)) {
    try {
      const quote = readFileSync(SECRETVM_TDX_ATTESTATION_PATH, 'utf-8');
      const instanceId = createHash('sha256').update(quote).digest('hex').slice(0, 32);
      return { instanceId, isTDX: true, codeHash };
    } catch {
      // Fall through
    }
  }

  // Try configfs-tsm report
  if (existsSync(TDX_REPORT_PATH)) {
    try {
      const report = readFileSync(`${TDX_REPORT_PATH}/outblob`);
      const instanceId = createHash('sha256').update(report).digest('hex').slice(0, 32);
      return { instanceId, isTDX: true, codeHash };
    } catch {
      // Fall through
    }
  }

  // Try SecretVM attestation API
  try {
    const res = await fetch(SECRETVM_ATTESTATION_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { instance_id?: string; report?: string };
      if (data.instance_id) {
        return { instanceId: data.instance_id, isTDX: true, codeHash };
      }
      if (data.report) {
        const instanceId = createHash('sha256')
          .update(data.report)
          .digest('hex')
          .slice(0, 32);
        return { instanceId, isTDX: true, codeHash };
      }
    }
  } catch {
    // Fall through to dev fallback
  }

  // Development fallback: deterministic from hostname + persistent seed
  const instanceId = getDevInstanceId();
  return { instanceId, isTDX: false, codeHash };
}

/**
 * Read TDX instance ID from /dev/tdx_guest.
 * Sends a TDX_CMD_GET_REPORT ioctl and extracts MRTD + RTMR registers.
 */
async function getTDXInstanceId(): Promise<string> {
  // The TDX guest report contains MRTD (48 bytes) and RTMR[0-3] (4 × 48 bytes).
  // We hash them together to create a unique instance ID.
  // In a full implementation, this would use ioctl TDX_CMD_GET_REPORT (0xc0).
  // For now, read the device and hash whatever we get.
  const deviceData = readFileSync(TDX_GUEST_DEVICE);
  return createHash('sha256').update(deviceData).digest('hex').slice(0, 32);
}

/**
 * Get a deterministic dev instance ID.
 * Persisted to a file so it survives restarts but is unique per machine.
 */
function getDevInstanceId(): string {
  const seedPath = '/tmp/.idiostasis-tee-dev-seed';

  let seed: string;
  try {
    seed = readFileSync(seedPath, 'utf-8').trim();
  } catch {
    // Generate and persist a new seed
    seed = randomBytes(16).toString('hex');
    try {
      writeFileSync(seedPath, seed, 'utf-8');
    } catch {
      // Can't persist, will change on restart
    }
  }

  const raw = `dev-${hostname()}-${seed}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Get the code hash of the running container/process.
 *
 * Priority:
 *   1. RTMR3 from SecretVM attestation API — measures the container rootfs +
 *      docker-compose.yaml, i.e. the exact GHCR image being run.
 *   2. Docker container ID (cgroup)
 *   3. package.json hash (dev fallback)
 */
function getCodeHash(): string {
  // Try RTMR3 from env (set by boot-agent or runtime)
  const rtmr3Env = process.env.RTMR3;
  if (rtmr3Env) return rtmr3Env;

  // Try RTMR3 from SecretVM self_report.txt
  if (existsSync(SECRETVM_SELF_REPORT_PATH)) {
    try {
      const report = readFileSync(SECRETVM_SELF_REPORT_PATH, 'utf-8');
      const match = report.match(/RTMR3:\s*([0-9a-fA-F]+)/);
      if (match) return match[1];
    } catch { /* fall through */ }
  }

  // Try Docker container ID (available inside containers)
  try {
    if (existsSync('/.dockerenv')) {
      const cgroup = readFileSync('/proc/self/cgroup', 'utf-8');
      const match = cgroup.match(/[a-f0-9]{64}/);
      if (match) {
        return match[0].slice(0, 32);
      }
    }
  } catch {
    // Not in Docker
  }

  // Fallback: hash the package.json + main entry
  try {
    const pkg = readFileSync('package.json', 'utf-8');
    return createHash('sha256').update(pkg).digest('hex').slice(0, 32);
  } catch {
    return 'unknown-code-hash';
  }
}
