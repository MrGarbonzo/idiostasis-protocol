/**
 * Multi-strategy quote extraction from cpu.html (Decision 4, spec Section 7).
 *
 * Always tries strategies in this exact order:
 *   1. <pre> tag content
 *   2. <textarea> tag content
 *   3. Longest hex string >= 128 chars
 *   4. Longest base64 string >= 128 chars
 *
 * Format has varied in production — never trust a single strategy.
 */

export type LogFn = (message: string) => void;

export function extractQuoteFromHtml(html: string, log: LogFn = () => {}): string {
  // Strategy 1: <pre> tag
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch?.[1]?.trim()) {
    log('attestation: extracted via <pre>');
    return preMatch[1].trim();
  }

  // Strategy 2: <textarea> tag
  const textareaMatch = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  if (textareaMatch?.[1]?.trim()) {
    log('attestation: extracted via <textarea>');
    return textareaMatch[1].trim();
  }

  // Strategy 3: longest hex string >= 128 chars
  const hexMatches = html.match(/[0-9a-fA-F]{128,}/g) ?? [];
  const longestHex = hexMatches.sort((a, b) => b.length - a.length)[0];
  if (longestHex) {
    log('attestation: extracted via longest hex string');
    return longestHex;
  }

  // Strategy 4: longest base64 string >= 128 chars
  const b64Matches = html.match(/[A-Za-z0-9+/]{128,}={0,2}/g) ?? [];
  const longestB64 = b64Matches.sort((a, b) => b.length - a.length)[0];
  if (longestB64) {
    log('attestation: extracted via longest base64 string');
    return longestB64;
  }

  throw new Error('attestation: all extraction strategies failed');
}
