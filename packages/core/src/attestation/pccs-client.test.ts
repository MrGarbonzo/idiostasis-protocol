import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWithPccs, type PccsFetcher } from './pccs-client.js';

describe('verifyWithPccs', () => {
  it('returns result from first endpoint on success', async () => {
    const fetcher: PccsFetcher = async () => ({
      rtmr3: 'abc123',
      tcb_status: 'UpToDate',
    });

    const result = await verifyWithPccs('test-quote', ['https://ep1.test'], fetcher);
    assert.equal(result.rtmr3, 'abc123');
    assert.equal(result.valid, true);
    assert.equal(result.tcbStatus, 'UpToDate');
  });

  it('falls back to second endpoint when first fails', async () => {
    let callCount = 0;
    const fetcher: PccsFetcher = async (url) => {
      callCount++;
      if (url === 'https://ep1.test') throw new Error('connection refused');
      return { rtmr3: 'from-ep2', tcb_status: 'UpToDate' };
    };

    const result = await verifyWithPccs(
      'test-quote',
      ['https://ep1.test', 'https://ep2.test'],
      fetcher,
    );
    assert.equal(callCount, 2);
    assert.equal(result.rtmr3, 'from-ep2');
  });

  it('throws when all endpoints fail', async () => {
    const fetcher: PccsFetcher = async () => {
      throw new Error('endpoint down');
    };

    await assert.rejects(
      verifyWithPccs('test-quote', ['https://ep1.test', 'https://ep2.test'], fetcher),
      { message: 'All PCCS endpoints exhausted' },
    );
  });

  it("correctly reads 'rtmr3' field name", async () => {
    const fetcher: PccsFetcher = async () => ({
      rtmr3: 'value-from-rtmr3',
      tcb_status: 'UpToDate',
    });

    const result = await verifyWithPccs('q', ['https://ep.test'], fetcher);
    assert.equal(result.rtmr3, 'value-from-rtmr3');
  });

  it("correctly reads 'rtmr_3' field name (alternate)", async () => {
    const fetcher: PccsFetcher = async () => ({
      rtmr_3: 'value-from-rtmr-underscore-3',
      tcb_status: 'UpToDate',
    });

    const result = await verifyWithPccs('q', ['https://ep.test'], fetcher);
    assert.equal(result.rtmr3, 'value-from-rtmr-underscore-3');
  });

  it('extracts rtmr3 from nested quote object', async () => {
    const fetcher: PccsFetcher = async () => ({
      status: { result: '0' },
      quote: { rtmr3: 'nested-rtmr3-value', mr_td: 'abcd' },
    });

    const result = await verifyWithPccs('q', ['https://ep.test'], fetcher);
    assert.equal(result.rtmr3, 'nested-rtmr3-value');
    assert.equal(result.tcbStatus, '0');
  });

  it('rejects response missing both field names', async () => {
    const fetcher: PccsFetcher = async () => ({
      some_other_field: 'no rtmr here',
      tcb_status: 'UpToDate',
    });

    await assert.rejects(
      verifyWithPccs('q', ['https://ep.test'], fetcher),
      { message: 'All PCCS endpoints exhausted' },
    );
  });
});
