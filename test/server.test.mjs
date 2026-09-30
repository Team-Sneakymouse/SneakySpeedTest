import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../lib/config.mjs';
import { networkContext, validateResults } from '../lib/results.mjs';
import { makeServer } from '../server.mjs';
import { reportFor } from './fixtures.mjs';

const config = makeConfig({});

test('recomputes speeds and only stores agreed fields, ignoring raw IP and fake metadata', () => {
  const report = reportFor(config);
  report.rawIp = '192.0.2.1';
  report.network = { country: 'US', asn: 1, ip: '192.0.2.1' };
  report.browser.extra = 'not collected';
  report.samples[0].mbps = 999999;
  const record = validateResults(report, config, { country: 'AT', asn: 1234 });
  assert.equal(record.country, 'AT');
  assert.equal(record.asn, 1234);
  assert.equal(record.production_mbps, config.sampleBytes * 8 / 1_000_000);
  assert.equal(record.results.samples[0].mbps, record.production_mbps);
  assert.ok(!JSON.stringify(record).includes('192.0.2.1'));
  assert.equal(record.results.browser.extra, undefined);
});

test('validates cancelled and failed reports without inventing complete route speeds', () => {
  const cancelled = reportFor(config);
  cancelled.status = 'cancelled';
  cancelled.samples = cancelled.samples.slice(0, 1);
  cancelled.samples[0].status = 'cancelled';
  cancelled.samples[0].bytes = 100;
  const record = validateResults(cancelled, config, { country: null, asn: null });
  assert.equal(record.results.summary.productionMbps, null);
  assert.equal(record.results.samples[0].bytes, 100);
  const failed = reportFor(config);
  failed.status = 'failed';
  failed.samples[0].status = 'timeout';
  failed.samples[0].bytes = 0;
  assert.equal(validateResults(failed, config, { country: null, asn: null }).status, 'failed');
});

test('rejects corrupt sample sizes, stale config, inconsistent order and malformed numbers', () => {
  const mutations = [
    r => { r.samples[0].bytes = 1; },
    r => { r.configId = 'old'; },
    r => { r.plan[1].endpointId = 'production'; },
    r => { r.samples[0].durationMs = 0; },
    r => { r.samples[0].durationMs = Infinity; },
    r => { r.samples[0].httpStatus = 200; },
    r => { r.samples.pop(); },
    r => { r.submissionId = '" || true'; },
  ];
  for (const mutate of mutations) {
    const report = reportFor(config);
    mutate(report);
    assert.throws(() => validateResults(report, config, { country: null, asn: null }));
  }
});

test('trusts network headers only when explicitly configured, and never returns an IP', () => {
  const headers = { 'cf-ipcountry': 'AT', 'x-visitor-asn': '1234', 'cf-connecting-ip': '192.0.2.1' };
  assert.deepEqual(networkContext(headers), { country: null, asn: null });
  assert.deepEqual(networkContext(headers, true), { country: 'AT', asn: 1234 });
  assert.deepEqual(networkContext({ 'cf-ipcountry': 'XX', 'x-visitor-asn': '1234, 5678' }, true), { country: null, asn: null });
});

test('serves UI/config without secrets and saves only on an explicit valid POST', async t => {
  const records = [];
  const server = makeServer({ env: { TRUST_PROXY_HEADERS: 'true', POCKETBASE_PASSWORD: 'do-not-expose' },
    pb: { configured: true, async save(record) { records.push(record); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Submit results'));
  const visible = await (await fetch(`${base}/api/config`)).text();
  assert.ok(!visible.includes('do-not-expose'));
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/results`)).status, 404);
  assert.equal(records.length, 0);
  const result = await fetch(`${base}/api/results`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'CF-IPCountry': 'AT', 'X-Visitor-ASN': '1234',
  }, body: JSON.stringify(reportFor(config)) });
  assert.equal(result.status, 200);
  assert.equal(records.length, 1);
  assert.equal(records[0].country, 'AT');
  const invalid = await fetch(`${base}/api/results`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalid.status, 400);
  assert.equal(records.length, 1);
});

test('database outage leaves retryable results and never leaks backend error details', async t => {
  const server = makeServer({ pb: { configured: true, async save() { throw new Error('secret backend detail'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await fetch(`http://127.0.0.1:${server.address().port}/api/results`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportFor(config)),
  });
  assert.equal(result.status, 503);
  const body = await result.text();
  assert.ok(body.includes('retry'));
  assert.ok(!body.includes('secret backend detail'));
});
