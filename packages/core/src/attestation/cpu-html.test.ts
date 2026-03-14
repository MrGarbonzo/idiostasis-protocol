import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuoteFromHtml } from './cpu-html.js';

const LONG_HEX = 'a'.repeat(256);
const LONG_B64 = 'A'.repeat(200) + '==';

describe('extractQuoteFromHtml', () => {
  it('strategy 1: succeeds when <pre> tag is present', () => {
    const html = `<html><body><pre>  ${LONG_HEX}  </pre></body></html>`;
    const logs: string[] = [];
    const result = extractQuoteFromHtml(html, (m) => logs.push(m));
    assert.equal(result, LONG_HEX);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes('<pre>'));
  });

  it('strategy 2: succeeds when only <textarea> tag is present', () => {
    const html = `<html><body><textarea>  some-quote-data  </textarea></body></html>`;
    const logs: string[] = [];
    const result = extractQuoteFromHtml(html, (m) => logs.push(m));
    assert.equal(result, 'some-quote-data');
    assert.ok(logs[0].includes('<textarea>'));
  });

  it('strategy 3: succeeds when only a long hex string is present', () => {
    const html = `<html><body><div>${LONG_HEX}</div></body></html>`;
    const logs: string[] = [];
    const result = extractQuoteFromHtml(html, (m) => logs.push(m));
    assert.equal(result, LONG_HEX);
    assert.ok(logs[0].includes('hex'));
  });

  it('strategy 4: succeeds when only a long base64 string is present', () => {
    // Use characters that are valid base64 but NOT valid hex
    const b64Only = 'QRSTU'.repeat(30) + '=='; // 152 chars, contains non-hex chars
    const html = `<html><body>${b64Only}</body></html>`;
    const logs: string[] = [];
    const result = extractQuoteFromHtml(html, (m) => logs.push(m));
    assert.equal(result, b64Only);
    assert.ok(logs[0].includes('base64'));
  });

  it('throws when all strategies fail', () => {
    const html = '<html><body>nothing useful here</body></html>';
    assert.throws(
      () => extractQuoteFromHtml(html),
      { message: 'attestation: all extraction strategies failed' },
    );
  });

  it('prefers <pre> over <textarea> when both present', () => {
    const html = '<pre>pre-quote</pre><textarea>textarea-quote</textarea>';
    const result = extractQuoteFromHtml(html);
    assert.equal(result, 'pre-quote');
  });

  it('each test logs which strategy was used', () => {
    const logs: string[] = [];
    extractQuoteFromHtml(`<pre>data</pre>`, (m) => logs.push(m));
    assert.equal(logs.length, 1);
    assert.ok(logs[0].startsWith('attestation:'));
  });
});
