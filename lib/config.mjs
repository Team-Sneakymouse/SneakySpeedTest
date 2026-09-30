import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

export function loadEnv() {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

export function makeConfig(env = process.env) {
  const path = '/packs/systems/6928fc795dd1074b21364ca4738064214254756bdea59ac86d0cf6e6eaad2a97.zip';
  const endpoints = [
    { id: 'production', label: 'Production domain', url: env.PRODUCTION_DOWNLOAD_URL || `https://resourcepack.rawb.tv${path}` },
    { id: 'comparison', label: 'R2 development domain', url: env.COMPARISON_DOWNLOAD_URL || `https://pub-ff873e817b264f5e8e334f6df6cc389b.r2.dev${path}` },
  ];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Download URLs must be public HTTPS URLs without credentials, queries, or fragments.');
    }
  }
  const config = { schemaVersion: 1, sampleBytes: 16 * 1024 * 1024, rounds: 2, timeoutMs: 30_000, endpoints };
  return { ...config, configId: createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16) };
}
