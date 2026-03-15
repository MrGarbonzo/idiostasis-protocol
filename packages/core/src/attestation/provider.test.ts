import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelfReport } from './provider.js';

describe('parseSelfReport', () => {
  it('extracts RTMR3 from JSON in <pre> tag', () => {
    const html = `<html><body><pre>{"rtmr0":"aaa","rtmr1":"bbb","rtmr2":"ccc","rtmr3":"${'d'.repeat(96)}","mrtd":"eee"}</pre></body></html>`;
    const report = parseSelfReport(html);
    assert.equal(report.rtmr3, 'd'.repeat(96));
    assert.equal(report.rtmr0, 'aaa');
    assert.equal(report.mrtd, 'eee');
  });

  it('extracts RTMR3 from table row format', () => {
    const rtmr3 = 'a1b2c3'.repeat(16); // 96 hex chars
    const html = `
      <table>
        <tr><td>rtmr0</td><td>${'0'.repeat(96)}</td></tr>
        <tr><td>RTMR3</td><td>${rtmr3}</td></tr>
      </table>
    `;
    const report = parseSelfReport(html);
    assert.equal(report.rtmr3, rtmr3);
    assert.equal(report.rtmr0, '0'.repeat(96));
  });

  it('extracts RTMR3 from regex key-value pattern', () => {
    const rtmr3 = 'f'.repeat(96);
    const html = `Some text\nRTMR3: ${rtmr3}\nMore text`;
    const report = parseSelfReport(html);
    assert.equal(report.rtmr3, rtmr3);
  });

  it('returns raw HTML when no strategy succeeds', () => {
    const html = '<html><body>Nothing useful here</body></html>';
    const report = parseSelfReport(html);
    assert.equal(report.rtmr3, undefined);
    assert.equal(report.raw, html);
  });

  it('extracts reportData from JSON', () => {
    const rd = 'ab'.repeat(48);
    const html = `<pre>{"rtmr3":"${'c'.repeat(96)}","reportData":"${rd}"}</pre>`;
    const report = parseSelfReport(html);
    assert.equal(report.reportData, rd);
  });

  it('extracts report_data with underscore from table', () => {
    const rd = 'ee'.repeat(48);
    const html = `<table><tr><td>report_data</td><td>${rd}</td></tr></table>`;
    const report = parseSelfReport(html);
    assert.equal(report.reportData, rd);
  });
});
