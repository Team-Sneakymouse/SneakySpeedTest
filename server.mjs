import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadEnv, makeConfig } from './lib/config.mjs';
import { PocketBase } from './lib/pocketbase.mjs';
import { networkContext, validateResults } from './lib/results.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/measurement.mjs', ['measurement.mjs', 'text/javascript; charset=utf-8']],
]);

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function makeServer({ env = process.env, pb = new PocketBase(env) } = {}) {
  const config = makeConfig(env);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') return reply(res, 200, { status: 'ok' });
    if (req.method === 'GET' && path === '/api/config') return reply(res, 200, { ...config, submissionsAvailable: pb.configured });
    if (req.method === 'GET' && path === '/api/context') return reply(res, 200, networkContext(req.headers, env.TRUST_PROXY_HEADERS === 'true'));
    if (req.method === 'POST' && path === '/api/results') {
      let record;
      try {
        record = validateResults(await readJson(req), config, networkContext(req.headers, env.TRUST_PROXY_HEADERS === 'true'));
      } catch (error) {
        return reply(res, 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message });
      }
      if (!pb.configured) return reply(res, 503, { error: 'Result storage is not configured. Your results are still here; save a local copy or retry later.' });
      try {
        await pb.save(record);
        return reply(res, 200, { submitted: true, submissionId: record.submission_id });
      } catch {
        console.error('Result storage failed. Check PocketBase connectivity, credentials, and collection schema.');
        return reply(res, 503, { error: 'Could not save your results. Please retry Submit; this will not create a duplicate.' });
      }
    }
    if (req.method === 'GET' && files.has(path)) {
      const [file, type] = files.get(path);
      try {
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(content);
      } catch { return reply(res, 500, { error: 'Could not load this page.' }); }
    }
    reply(res, 404, { error: 'Not found.' });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadEnv();
  const server = makeServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`SneakySpeedTest listening on port ${port}.`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
