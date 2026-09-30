import test from 'node:test';
import assert from 'node:assert/strict';
import { PocketBase } from '../lib/pocketbase.mjs';

const env = { POCKETBASE_HOST: 'https://db.example.test', POCKETBASE_USERNAME: 'temporary@example.test', POCKETBASE_PASSWORD: 'test-password' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('reuses auth, retries a expired token, and never recreates a submitted UUID', async () => {
  let auths = 0;
  let creates = 0;
  let denied = false;
  const records = new Map();
  const pb = new PocketBase(env, async (url, options) => {
    if (url.includes('auth-with-password')) { auths++; return json({ token: `token-${auths}` }); }
    if (!denied) { denied = true; return json({}, 401); }
    assert.equal(options.headers.Authorization, 'token-2');
    if (options.method === 'POST') {
      creates++;
      const body = JSON.parse(options.body);
      records.set(body.submission_id, body);
      return json(body);
    }
    return json({ items: [...records.values()] });
  });
  const record = { submission_id: 'test-uuid', results: {} };
  await pb.save(record);
  await pb.save(record);
  assert.equal(auths, 2);
  assert.equal(creates, 1);
});

test('a lost create response is recovered by looking up the unique submission', async () => {
  let record;
  const pb = new PocketBase(env, async (url, options) => {
    if (url.includes('auth-with-password')) return json({ token: 'token' });
    if (options.method === 'POST') { record = JSON.parse(options.body); throw new TypeError('Connection lost'); }
    return json({ items: record ? [record] : [] });
  });
  assert.deepEqual(await pb.save({ submission_id: 'test-uuid' }), { submission_id: 'test-uuid' });
});
