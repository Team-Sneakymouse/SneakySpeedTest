import { randomUUID } from 'node:crypto';
import { makePlan } from '../public/measurement.mjs';

export function reportFor(config) {
  const plan = makePlan(config, true);
  return { schemaVersion: 1, configId: config.configId, submissionId: randomUUID(), username: '', status: 'completed',
    startedAt: '2026-09-30T12:00:00.000Z', finishedAt: '2026-09-30T12:01:00.000Z', wasBackgrounded: false,
    browser: { userAgent: 'Test browser', language: 'en', serviceWorkerControlled: false }, plan,
    samples: plan.map(slot => ({ ...slot, startedAt: '2026-09-30T12:00:00.000Z', status: 'succeeded',
      bytes: config.sampleBytes, durationMs: 1000, headersMs: 50, firstByteMs: 60, httpStatus: 206,
      cfRay: 'abc-TXL', cacheStatus: 'HIT', contentRange: null, etag: 'pack-v1', error: null })) };
}
