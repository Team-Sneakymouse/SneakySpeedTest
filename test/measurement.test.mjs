import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, measureSample, summarize } from '../public/measurement.mjs';

const config = { sampleBytes: 16, timeoutMs: 1000 };
const slot = { endpointId: 'production', round: 1, rangeStart: 0, rangeEnd: 15 };
const endpoint = { url: 'https://example.test/pack.zip' };

test('reverses a randomizable order in round two, using the next range', () => {
  const plan = makePlan(config, false);
  assert.deepEqual(plan.map(s => s.endpointId), ['comparison', 'production', 'production', 'comparison']);
  assert.deepEqual(plan.map(s => [s.rangeStart, s.rangeEnd]), [[0, 15], [0, 15], [16, 31], [16, 31]]);
});

test('streams a bounded range and preserves diagnostic response headers', async () => {
  let tick = 0;
  const sample = await measureSample(endpoint, slot, config, {
    now: () => { tick += 10; return tick; },
    fetcher: async (url, options) => {
      assert.equal(url, endpoint.url);
      assert.deepEqual(options.headers, { Range: 'bytes=0-15' });
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return new Response(new Uint8Array(16), { status: 206, headers: {
        'Content-Range': 'bytes 0-15/64', 'Content-Length': '16', 'CF-Ray': 'abc-TXL', 'CF-Cache-Status': 'HIT', ETag: 'pack-v1',
      } });
    },
  });
  assert.equal(sample.status, 'succeeded');
  assert.equal(sample.bytes, 16);
  assert.equal(sample.cfRay, 'abc-TXL');
  assert.equal(sample.cacheStatus, 'HIT');
  assert.ok(sample.headersMs < sample.firstByteMs);
  assert.equal(sample.mbps, 16 * 8 / sample.durationMs / 1000);
});

test('does not accept an entire-file response or a different range', async () => {
  for (const response of [new Response(new Uint8Array(100), { status: 200 }),
    new Response(new Uint8Array(16), { status: 206, headers: { 'Content-Range': 'bytes 16-31/64' } })]) {
    const sample = await measureSample(endpoint, slot, config, { fetcher: async () => response });
    assert.equal(sample.status, 'error');
    assert.equal(sample.bytes, 0);
  }
});

test('missing exposed headers still allows measurement; a truncated body retains partial bytes', async () => {
  const complete = await measureSample(endpoint, slot, config, { fetcher: async () => new Response(new Uint8Array(16), { status: 206 }) });
  assert.equal(complete.status, 'succeeded');
  assert.equal(complete.cfRay, null);
  const partial = await measureSample(endpoint, slot, config, { fetcher: async () => new Response(new Uint8Array(8), { status: 206 }) });
  assert.equal(partial.status, 'error');
  assert.equal(partial.bytes, 8);
  assert.ok(partial.mbps > 0);
  assert.equal(summarize([partial], 'production'), null);
});

function pendingFetch(_url, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

test('timeout and participant cancellation remain distinct', async () => {
  const timeout = await measureSample(endpoint, slot, { ...config, timeoutMs: 10 }, { fetcher: pendingFetch });
  assert.equal(timeout.status, 'timeout');
  const controller = new AbortController();
  const pending = measureSample(endpoint, slot, config, { signal: controller.signal, fetcher: pendingFetch });
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
});

test('cancelling a streaming body preserves already received bytes', async () => {
  const controller = new AbortController();
  const sample = await measureSample(endpoint, slot, config, { signal: controller.signal, fetcher: async (_url, { signal }) => {
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array(8));
      signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      setTimeout(() => controller.abort(), 10);
    } }), { status: 206 });
  } });
  assert.equal(sample.status, 'cancelled');
  assert.equal(sample.bytes, 8);
});
