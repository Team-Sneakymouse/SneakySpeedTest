import { summarize } from '../public/measurement.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const statuses = new Set(['succeeded', 'timeout', 'error', 'cancelled']);
function invalid() { throw new Error('Invalid test results. Please run a new test.'); }
function text(value, max, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > max) invalid();
  return value;
}
function number(value, max, optional = false) {
  if (optional && value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > max) invalid();
  return value;
}
function date(value) {
  text(value, 32);
  if (!Number.isFinite(Date.parse(value))) invalid();
  return value;
}

export function networkContext(headers, trustProxy = false) {
  if (!trustProxy) return { country: null, asn: null };
  const country = headers['cf-ipcountry'];
  const rawAsn = headers['x-visitor-asn'];
  const asn = typeof rawAsn === 'string' && /^\d{1,10}$/.test(rawAsn) ? Number(rawAsn) : null;
  return {
    country: typeof country === 'string' && /^[A-Z]{2}$/.test(country) && !['XX', 'T1'].includes(country) ? country : null,
    asn: Number.isInteger(asn) && asn > 0 && asn <= 4294967295 ? asn : null,
  };
}

export function validateResults(body, config, context) {
  if (!body || !uuid.test(body.submissionId) || body.configId !== config.configId || body.schemaVersion !== 1) invalid();
  const username = text(body.username, 64).trim();
  if (!['completed', 'failed', 'cancelled'].includes(body.status)) invalid();
  if (!Array.isArray(body.plan) || body.plan.length !== 4 || !Array.isArray(body.samples) || body.samples.length > 4) invalid();
  const plan = body.plan.map((slot, index) => {
    if (!slot || !['production', 'comparison'].includes(slot.endpointId) || slot.round !== Math.floor(index / 2) + 1
      || slot.rangeStart !== Math.floor(index / 2) * config.sampleBytes || slot.rangeEnd !== slot.rangeStart + config.sampleBytes - 1) invalid();
    return { endpointId: slot.endpointId, round: slot.round, rangeStart: slot.rangeStart, rangeEnd: slot.rangeEnd };
  });
  if (plan[0].endpointId === plan[1].endpointId || plan[0].endpointId !== plan[3].endpointId || plan[1].endpointId !== plan[2].endpointId) invalid();
  const samples = body.samples.map((sample, index) => {
    const slot = plan[index];
    if (!sample || Object.keys(slot).some(key => sample[key] !== slot[key]) || !statuses.has(sample.status)) invalid();
    const bytes = number(sample.bytes, config.sampleBytes + 1024 * 1024);
    if (!Number.isInteger(bytes)) invalid();
    const durationMs = number(sample.durationMs, 24 * 60 * 60 * 1000);
    if (durationMs < 1 || (sample.status === 'succeeded' && bytes !== config.sampleBytes)) invalid();
    const firstByteMs = number(sample.firstByteMs, durationMs, true);
    const headersMs = number(sample.headersMs, durationMs, true);
    const httpStatus = number(sample.httpStatus, 599, true);
    if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100)) invalid();
    if (sample.status === 'succeeded' && httpStatus !== 206) invalid();
    return { ...slot, status: sample.status, startedAt: date(sample.startedAt), bytes, durationMs, headersMs, firstByteMs,
      mbps: bytes * 8 / durationMs / 1000,
      transferMbps: firstByteMs === null || !bytes ? null : bytes * 8 / Math.max(1, durationMs - firstByteMs) / 1000,
      httpStatus, cfRay: text(sample.cfRay, 128, true), cacheStatus: text(sample.cacheStatus, 64, true),
      contentRange: text(sample.contentRange, 128, true), etag: text(sample.etag, 256, true), error: text(sample.error, 240, true) };
  });
  if (body.status !== 'cancelled' && samples.length !== 4) invalid();
  if (samples.some(sample => sample.status === 'cancelled') && body.status !== 'cancelled') invalid();
  if (body.status === 'completed' && samples.some(sample => sample.status !== 'succeeded')) invalid();
  if (body.status === 'failed' && samples.every(sample => sample.status === 'succeeded')) invalid();
  if (!body.browser || typeof body.wasBackgrounded !== 'boolean') invalid();
  const production = summarize(samples, 'production');
  const comparison = summarize(samples, 'comparison');
  const results = { schemaVersion: 1, submissionId: body.submissionId, configId: config.configId, username, status: body.status,
    startedAt: date(body.startedAt), finishedAt: date(body.finishedAt),
    browser: { userAgent: text(body.browser.userAgent, 1024), language: text(body.browser.language, 64),
      serviceWorkerControlled: Boolean(body.browser.serviceWorkerControlled) },
    wasBackgrounded: body.wasBackgrounded, network: context, config, plan, samples,
    summary: { productionMbps: production, comparisonMbps: comparison },
    disclosureVersion: '2026-09-30', submittedAt: new Date().toISOString() };
  return { submission_id: body.submissionId, username, status: body.status, country: context.country || '',
    asn: context.asn || 0, production_mbps: production || 0, comparison_mbps: comparison || 0, results };
}
