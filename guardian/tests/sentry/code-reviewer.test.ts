import { describe, it, expect } from 'vitest';
import { CodeReviewer } from '../../src/sentry/code-reviewer.js';

describe('CodeReviewer', () => {
  const reviewer = new CodeReviewer();

  describe('reviewDiff', () => {
    it('approves clean diff', () => {
      const diff = `
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 import { foo } from './foo.js';
+import { bar } from './bar.js';

-const x = foo();
+const x = bar(foo());
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(true);
      expect(result.criticalCount).toBe(0);
      expect(result.warningCount).toBe(0);
      expect(result.recommendation).toBe('approve');
    });

    it('flags eval as critical', () => {
      const diff = `
+const result = eval(userInput);
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
      expect(result.criticalCount).toBeGreaterThanOrEqual(1);
      expect(result.recommendation).toBe('reject');
      expect(result.findings.some((f) => f.reason.includes('eval'))).toBe(true);
    });

    it('flags hardcoded private key', () => {
      const diff = `
+const private_key = "5JxnRz8bLkMdPkF...";
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
      expect(result.findings.some((f) => f.reason.includes('private key'))).toBe(true);
    });

    it('flags hardcoded mnemonic', () => {
      const diff = `
+const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
      expect(result.findings.some((f) => f.reason.includes('mnemonic'))).toBe(true);
    });

    it('flags child_process import', () => {
      const diff = `
+import { exec } from 'child_process';
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
      expect(result.findings.some((f) => f.reason.includes('Child process'))).toBe(true);
    });

    it('flags ngrok tunnels', () => {
      const diff = `
+const endpoint = "https://abc123.ngrok.io/api";
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
      expect(result.findings.some((f) => f.reason.includes('Ngrok'))).toBe(true);
    });

    it('flags DROP TABLE', () => {
      const diff = `
+db.exec("DROP TABLE accounts");
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
    });

    it('flags disabled invariant verification', () => {
      const diff = `
+const verifyInvariants = false;
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.approved).toBe(false);
    });

    it('only reviews added lines (ignores removed)', () => {
      const diff = `
-const result = eval(userInput);
+const result = safeEvaluate(userInput);
`.trim();

      const result = reviewer.reviewDiff(diff);
      // The removed line has eval but shouldn't be flagged
      // The added line has "Evaluate" but not "eval("
      expect(result.criticalCount).toBe(0);
    });

    it('recommends manual_review for many warnings', () => {
      const diff = `
+const url1 = "http://192.168.1.1/api";
+const url2 = "http://10.0.0.1/api";
+const url3 = "http://172.16.0.1/api";
+const url4 = "http://192.168.1.2/api";
`.trim();

      const result = reviewer.reviewDiff(diff);
      expect(result.warningCount).toBeGreaterThanOrEqual(4);
      expect(result.recommendation).toBe('manual_review');
    });
  });

  describe('reviewSource', () => {
    it('reviews full source code', () => {
      const source = `
import { foo } from './foo.js';
const x = foo();
console.log(x);
`.trim();

      const result = reviewer.reviewSource(source);
      expect(result.approved).toBe(true);
      expect(result.linesReviewed).toBe(3);
    });

    it('catches suspicious patterns in source', () => {
      const source = `
import { execSync } from 'child_process';
execSync('rm -rf /');
`.trim();

      const result = reviewer.reviewSource(source);
      expect(result.approved).toBe(false);
      expect(result.criticalCount).toBeGreaterThanOrEqual(2); // child_process + execSync + rm -rf
    });
  });
});
