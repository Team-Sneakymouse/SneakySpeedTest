export function makePlan(config, productionFirst = crypto.getRandomValues(new Uint8Array(1))[0] < 128) {
  const first = productionFirst ? ['production', 'comparison'] : ['comparison', 'production'];
  return [first, [...first].reverse()].flatMap((order, round) => order.map(endpointId => ({
    endpointId, round: round + 1, rangeStart: round * config.sampleBytes,
    rangeEnd: (round + 1) * config.sampleBytes - 1,
  })));
}

export async function measureSample(endpoint, slot, config, { signal, onProgress = () => {}, fetcher = fetch, now = () => performance.now() } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  const began = now();
  const result = { ...slot, startedAt: new Date().toISOString(), status: 'error', bytes: 0,
    durationMs: 0, headersMs: null, firstByteMs: null, mbps: 0, transferMbps: null,
    httpStatus: null, cfRay: null, cacheStatus: null, contentRange: null, etag: null, error: null };
  let reader;
  let lastUpdate = began;
  try {
    const response = await fetcher(endpoint.url, {
      headers: { Range: `bytes=${slot.rangeStart}-${slot.rangeEnd}` },
      mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    result.headersMs = now() - began;
    result.httpStatus = response.status;
    for (const [key, header] of [['cfRay', 'cf-ray'], ['cacheStatus', 'cf-cache-status'], ['contentRange', 'content-range'], ['etag', 'etag']]) {
      result[key] = response.headers.get(header);
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`Expected a byte-range response (206), received ${response.status}.`);
    }
    if (result.contentRange) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(result.contentRange);
      if (!range || Number(range[1]) !== slot.rangeStart || Number(range[2]) !== slot.rangeEnd) {
        await response.body?.cancel();
        throw new Error('The server returned a different byte range than requested.');
      }
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== config.sampleBytes) {
      await response.body?.cancel();
      throw new Error('The download payload is smaller or larger than the expected sample.');
    }
    if (!response.body) throw new Error('The browser did not provide a readable download stream.');
    reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const elapsed = now() - began;
      if (value.byteLength && result.firstByteMs === null) result.firstByteMs = elapsed;
      result.bytes += value.byteLength;
      if (result.bytes > config.sampleBytes) throw new Error('The server exceeded the requested sample size.');
      if (now() - lastUpdate >= 150 || result.bytes === config.sampleBytes) {
        onProgress({ bytes: result.bytes, elapsedMs: elapsed });
        lastUpdate = now();
      }
    }
    if (result.bytes !== config.sampleBytes) throw new Error('The download ended before the sample was complete.');
    result.status = 'succeeded';
  } catch (error) {
    result.status = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'error';
    result.error = result.status === 'cancelled' ? 'Cancelled by participant.'
      : result.status === 'timeout' ? 'Download exceeded the 30-second limit.'
      : error instanceof TypeError ? 'Browser could not read the download. Check CORS or network connectivity.'
      : String(error.message || 'Download failed.').slice(0, 240);
  } finally {
    result.durationMs = Math.max(1, now() - began);
    result.mbps = result.bytes * 8 / result.durationMs / 1000;
    if (result.firstByteMs !== null && result.bytes) {
      result.transferMbps = result.bytes * 8 / Math.max(1, result.durationMs - result.firstByteMs) / 1000;
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    if (reader) {
      try { await reader.cancel(); } catch { /* Aborting a stream can also reject cancellation. */ }
      reader.releaseLock();
    }
  }
  return result;
}

export function summarize(samples, endpointId) {
  const succeeded = samples.filter(sample => sample.endpointId === endpointId && sample.status === 'succeeded');
  if (!succeeded.length) return null;
  const bytes = succeeded.reduce((sum, sample) => sum + sample.bytes, 0);
  const ms = succeeded.reduce((sum, sample) => sum + sample.durationMs, 0);
  return bytes * 8 / ms / 1000;
}
