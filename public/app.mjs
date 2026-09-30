import { makePlan, measureSample, summarize } from './measurement.mjs';

const $ = id => document.getElementById(id);
let config;
let report = null;
let controller = null;
let context = { country: null, asn: null };
let submitted = false;
const mbps = value => value === null ? '—' : value.toFixed(value < 10 ? 2 : 1);
const mib = value => (value / 1024 / 1024).toFixed(1);

function notice(message) { $('notice').textContent = message; $('notice').hidden = false; }
function updatePreview() {
  if (!report) return;
  report.username = $('username').value.trim();
  $('report-preview').textContent = JSON.stringify({ ...report, network: context, config, disclosureVersion: '2026-09-30' }, null, 2);
}

async function refreshContext() {
  try {
    const response = await fetch('/api/context', { cache: 'no-store' });
    if (response.ok) context = await response.json();
  } catch { /* Unknown country/ASN should not prevent a participant submitting. */ }
  updatePreview();
}

function renderSamples() {
  for (const endpoint of config.endpoints) {
    const samples = report.samples.filter(sample => sample.endpointId === endpoint.id);
    const speed = summarize(report.samples, endpoint.id);
    $(`${endpoint.id}-speed`).textContent = mbps(speed);
    const list = $(`${endpoint.id}-samples`);
    list.replaceChildren();
    for (const sample of samples) {
      const row = document.createElement('div');
      row.className = `sample-row${sample.status === 'succeeded' ? '' : ' error'}`;
      const label = document.createElement('span');
      label.textContent = `#${sample.round}`;
      label.setAttribute('aria-label', `Sample ${sample.round}`);
      const result = document.createElement('span');
      result.textContent = sample.status === 'succeeded' ? `${mbps(sample.mbps)} Mbps · ${(sample.durationMs / 1000).toFixed(2)}s`
        : `${sample.status} · ${mbps(sample.mbps)} Mbps partial · ${mib(sample.bytes)} MiB`;
      row.title = sample.error || `${sample.cfRay || 'Cloudflare edge unavailable'} · ${sample.cacheStatus || 'cache status unavailable'}`;
      row.append(label, result);
      list.append(row);
    }
  }
}

async function runTest() {
  if (!config || controller) return;
  controller = new AbortController();
  submitted = false;
  $('start').disabled = true;
  $('start').textContent = 'Running…';
  $('cancel').hidden = false;
  $('cancel').disabled = false;
  $('cancel').textContent = 'Stop';
  $('progress-area').hidden = false;
  $('progress').value = 0;
  $('progress-value').textContent = '0 / 4 samples';
  $('outcome').hidden = true;
  $('submit-section').hidden = true;
  $('submit').disabled = !config.submissionsAvailable;
  $('submit').textContent = 'Submit';
  $('username').disabled = false;
  $('submit-status').textContent = config.submissionsAvailable ? '' : 'Submission unavailable.';
  report = {
    schemaVersion: config.schemaVersion, configId: config.configId, submissionId: crypto.randomUUID(),
    username: $('username').value.trim(), startedAt: new Date().toISOString(), finishedAt: null,
    status: 'completed', wasBackgrounded: document.hidden,
    browser: { userAgent: navigator.userAgent, language: navigator.language, serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller) },
    plan: makePlan(config), samples: [],
  };
  renderSamples();
  const onVisibility = () => { if (document.hidden) report.wasBackgrounded = true; };
  document.addEventListener('visibilitychange', onVisibility);
  const onLeave = event => { event.preventDefault(); event.returnValue = ''; };
  window.addEventListener('beforeunload', onLeave);
  try {
    for (const slot of report.plan) {
      if (controller.signal.aborted) break;
      const endpoint = config.endpoints.find(item => item.id === slot.endpointId);
      const completed = report.samples.length;
      $('progress-label').textContent = `${$(slot.endpointId + '-host').textContent} · ${slot.round}/2`;
      $('live-speed').textContent = 'Connecting…';
      const sample = await measureSample(endpoint, slot, config, {
        signal: controller.signal,
        onProgress({ bytes, elapsedMs }) {
          $('progress').value = completed + Math.min(1, bytes / config.sampleBytes);
          $('live-speed').textContent = `${mib(bytes)} / 16 MiB · ${mbps(bytes * 8 / Math.max(1, elapsedMs) / 1000)} Mbps`;
        },
      });
      report.samples.push(sample);
      $('progress').value = report.samples.length;
      $('progress-value').textContent = `${report.samples.length} / 4 samples`;
      renderSamples();
    }
    report.status = controller.signal.aborted ? 'cancelled'
      : report.samples.every(sample => sample.status === 'succeeded') ? 'completed' : 'failed';
  } catch {
    // Keep already completed samples submittable even after an unexpected browser error.
    report.status = 'cancelled';
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('beforeunload', onLeave);
    report.finishedAt = new Date().toISOString();
    controller = null;
    $('cancel').hidden = true;
    $('start').textContent = 'Finished';
    $('progress-area').hidden = true;
    $('outcome').hidden = false;
    const prod = summarize(report.samples, 'production');
    const comp = summarize(report.samples, 'comparison');
    $('outcome-text').textContent = report.status !== 'completed' ? 'Partial results can be submitted.'
      : prod && comp && comp / prod > 1.5 ? `R2.dev was ${(comp / prod).toFixed(1)}× faster.`
      : prod && comp && prod / comp > 1.5 ? `Production was ${(prod / comp).toFixed(1)}× faster.` : 'Similar speeds.';
    $('submit-section').hidden = false;
    updatePreview();
    void refreshContext();
  }
}

$('start').addEventListener('click', runTest);
$('again').addEventListener('click', runTest);
$('cancel').addEventListener('click', () => {
  $('cancel').disabled = true;
  $('cancel').textContent = 'Stopping…';
  controller?.abort();
});
$('username').addEventListener('input', updatePreview);
$('download').addEventListener('click', () => {
  updatePreview();
  const blob = new Blob([$('report-preview').textContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sneakyspeedtest-${report.submissionId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('submit').addEventListener('click', async () => {
  if (!report || submitted) return;
  updatePreview();
  $('submit').disabled = true;
  $('again').disabled = true;
  $('username').disabled = true;
  $('submit-status').textContent = 'Submitting…';
  try {
    const response = await fetch('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Submission failed. Please retry.');
    submitted = true;
    $('submit').textContent = 'Submitted';
    $('submit-status').textContent = 'Thank you for your help. You can close this tab now.';
  } catch (error) {
    $('submit-status').textContent = error.name === 'TimeoutError' ? 'Submission timed out. Retry Submit; it will not create a duplicate.'
      : error instanceof TypeError ? 'Could not reach the server. Your results are still here; retry Submit.' : error.message;
    $('submit').disabled = false;
    $('username').disabled = false;
  } finally { $('again').disabled = false; }
});

try {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the test configuration. Please reload.');
  config = await response.json();
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (mobile) {
    notice('Open this on your Minecraft PC.');
    $('start').textContent = 'Desktop computer required';
  } else if (!window.isSecureContext || !crypto.randomUUID || !window.ReadableStream) {
    notice('Use a current desktop browser over HTTPS, or localhost for local testing.');
    $('start').textContent = 'Browser update required';
  } else {
    $('start').disabled = false;
    $('start').textContent = 'Start';
  }
  for (const endpoint of config.endpoints) {
    const hostname = new URL(endpoint.url).hostname;
    $(`${endpoint.id}-host`).textContent = hostname.endsWith('.r2.dev') ? 'r2.dev' : hostname;
    $(`${endpoint.id}-host`).title = hostname;
  }
  if (!config.submissionsAvailable) notice('Submission unavailable. Local testing only.');
  void refreshContext();
} catch (error) { notice(error.message); $('start').textContent = 'Unable to load test'; }
