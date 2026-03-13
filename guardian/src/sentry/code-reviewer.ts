/**
 * Code Review System — automated review of code update proposals.
 * Detects suspicious patterns, verifies Docker image hashes, runs basic checks.
 */

/** Suspicious patterns to flag during code review. */
const SUSPICIOUS_PATTERNS: { pattern: RegExp; severity: 'critical' | 'warning'; reason: string }[] = [
  // Code execution
  { pattern: /\beval\s*\(/, severity: 'critical', reason: 'Dynamic code execution (eval)' },
  { pattern: /new\s+Function\s*\(/, severity: 'critical', reason: 'Dynamic function creation' },
  { pattern: /child_process/, severity: 'critical', reason: 'Child process execution' },
  { pattern: /\bexec\s*\(/, severity: 'warning', reason: 'Shell command execution' },
  { pattern: /\bexecSync\s*\(/, severity: 'critical', reason: 'Synchronous shell execution' },
  { pattern: /\bspawn\s*\(/, severity: 'warning', reason: 'Process spawning' },

  // Credential exposure
  { pattern: /private[_\s]?key\s*[:=]\s*['"`]/, severity: 'critical', reason: 'Hardcoded private key' },
  { pattern: /mnemonic\s*[:=]\s*['"`]/, severity: 'critical', reason: 'Hardcoded mnemonic' },
  { pattern: /secret\s*[:=]\s*['"`][A-Za-z0-9+/=]{20,}/, severity: 'critical', reason: 'Hardcoded secret' },
  { pattern: /password\s*[:=]\s*['"`][^'"` ]{8,}/, severity: 'warning', reason: 'Hardcoded password' },

  // Suspicious network
  { pattern: /https?:\/\/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/, severity: 'warning', reason: 'Hardcoded IP address URL' },
  { pattern: /\.ngrok\./, severity: 'critical', reason: 'Ngrok tunnel (potential exfiltration)' },
  { pattern: /pastebin\.com/, severity: 'critical', reason: 'Pastebin reference' },

  // Dangerous operations
  { pattern: /rm\s+-rf\s+\//, severity: 'critical', reason: 'Recursive root deletion' },
  { pattern: /DROP\s+TABLE/i, severity: 'critical', reason: 'SQL DROP TABLE' },
  { pattern: /TRUNCATE\s+TABLE/i, severity: 'critical', reason: 'SQL TRUNCATE TABLE' },

  // Fund manipulation
  { pattern: /transfer\s*\(.*private/, severity: 'critical', reason: 'Transfer using private key directly' },
  { pattern: /withdraw.*all|drain/i, severity: 'warning', reason: 'Potential fund drain pattern' },

  // Disabled safety
  { pattern: /verifyInvariants.*=.*false/, severity: 'critical', reason: 'Invariant verification disabled' },
  { pattern: /HARD_LIMITS.*=.*\{/, severity: 'warning', reason: 'Hard limits modification' },
  { pattern: /maxPositionPct.*[5-9]\d|100/, severity: 'warning', reason: 'Position limit set very high' },
];

export interface CodeReviewFinding {
  line: number;
  severity: 'critical' | 'warning';
  reason: string;
  snippet: string;
}

export interface CodeReviewResult {
  approved: boolean;
  findings: CodeReviewFinding[];
  criticalCount: number;
  warningCount: number;
  linesReviewed: number;
  recommendation: 'approve' | 'reject' | 'manual_review';
}

export interface DockerImageVerification {
  imageTag: string;
  expectedHash: string;
  actualHash: string | null;
  verified: boolean;
  error?: string;
}

export class CodeReviewer {
  /**
   * Review a code diff for suspicious patterns.
   * Only reviews added lines (lines starting with '+' in unified diff).
   */
  reviewDiff(diff: string): CodeReviewResult {
    const lines = diff.split('\n');
    const findings: CodeReviewFinding[] = [];
    let linesReviewed = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Only check added lines in the diff
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      linesReviewed++;

      const content = line.slice(1); // Remove the '+' prefix

      for (const rule of SUSPICIOUS_PATTERNS) {
        if (rule.pattern.test(content)) {
          findings.push({
            line: i + 1,
            severity: rule.severity,
            reason: rule.reason,
            snippet: content.trim().slice(0, 120),
          });
        }
      }
    }

    const criticalCount = findings.filter((f) => f.severity === 'critical').length;
    const warningCount = findings.filter((f) => f.severity === 'warning').length;

    let recommendation: 'approve' | 'reject' | 'manual_review';
    if (criticalCount > 0) {
      recommendation = 'reject';
    } else if (warningCount > 3) {
      recommendation = 'manual_review';
    } else {
      recommendation = 'approve';
    }

    return {
      approved: criticalCount === 0,
      findings,
      criticalCount,
      warningCount,
      linesReviewed,
      recommendation,
    };
  }

  /**
   * Review raw source code (not a diff — reviews all lines).
   * Used when the full source is submitted instead of a diff.
   */
  reviewSource(source: string): CodeReviewResult {
    const lines = source.split('\n');
    const findings: CodeReviewFinding[] = [];

    for (let i = 0; i < lines.length; i++) {
      const content = lines[i];

      for (const rule of SUSPICIOUS_PATTERNS) {
        if (rule.pattern.test(content)) {
          findings.push({
            line: i + 1,
            severity: rule.severity,
            reason: rule.reason,
            snippet: content.trim().slice(0, 120),
          });
        }
      }
    }

    const criticalCount = findings.filter((f) => f.severity === 'critical').length;
    const warningCount = findings.filter((f) => f.severity === 'warning').length;

    let recommendation: 'approve' | 'reject' | 'manual_review';
    if (criticalCount > 0) {
      recommendation = 'reject';
    } else if (warningCount > 3) {
      recommendation = 'manual_review';
    } else {
      recommendation = 'approve';
    }

    return {
      approved: criticalCount === 0,
      findings,
      criticalCount,
      warningCount,
      linesReviewed: lines.length,
      recommendation,
    };
  }

  /**
   * Verify a Docker image hash against an expected value.
   * Fetches the image digest from a registry.
   */
  async verifyDockerImage(
    imageTag: string,
    expectedHash: string,
  ): Promise<DockerImageVerification> {
    try {
      // Parse image tag: registry/repo:tag
      const [repoTag] = imageTag.split('@');
      const parts = repoTag.split(':');
      const repo = parts[0];
      const tag = parts[1] ?? 'latest';

      // Query Docker Hub registry API for the digest
      const tokenRes = await fetch(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!tokenRes.ok) throw new Error(`Auth failed: HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token: string };

      const manifestRes = await fetch(
        `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.docker.distribution.manifest.v2+json',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!manifestRes.ok) throw new Error(`Manifest fetch failed: HTTP ${manifestRes.status}`);

      const digest = manifestRes.headers.get('docker-content-digest');

      return {
        imageTag,
        expectedHash,
        actualHash: digest,
        verified: digest === expectedHash,
      };
    } catch (err) {
      return {
        imageTag,
        expectedHash,
        actualHash: null,
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
