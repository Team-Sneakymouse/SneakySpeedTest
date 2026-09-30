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
    const good = samples.filter(sample => sample.status === 'succeeded').length;
    $(`${endpoint.id}-detail`).textContent = speed === null ? (samples.length ? 'No complete samples yet' : 'Waiting for this route')
      : `${(speed / 8).toFixed(2)} MB/s · ${good} of 2 samples complete`;
    const list = $(`${endpoint.id}-samples`);
    list.replaceChildren();
    for (const sample of samples) {
      const row = document.createElement('div');
      row.className = `sample-row${sample.status === 'succeeded' ? '' : ' error'}`;
      const label = document.createElement('span');
      label.textContent = `Sample ${sample.round}`;
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
  $('start').textContent = 'Test running…';
  $('cancel').hidden = false;
  $('cancel').disabled = false;
  $('cancel').textContent = 'Stop test';
  $('progress-area').hidden = false;
  $('progress').value = 0;
  $('progress-value').textContent = '0 / 4 samples';
  $('outcome').hidden = true;
  $('submit-section').hidden = true;
  $('test-state').textContent = 'TEST IN PROGRESS';
  $('submit').disabled = !config.submissionsAvailable;
  $('submit').textContent = 'Submit results';
  $('username').disabled = false;
  $('submit-status').textContent = config.submissionsAvailable ? '' : 'Storage is not configured. You can save a local copy.';
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
      $('progress-label').textContent = `${endpoint.label} · sample ${slot.round} of 2`;
      $('live-speed').textContent = 'Connecting…';
      const sample = await measureSample(endpoint, slot, config, {
        signal: controller.signal,
        onProgress({ bytes, elapsedMs }) {
          $('progress').value = completed + Math.min(1, bytes / config.sampleBytes);
          $('live-speed').textContent = `${mib(bytes)} / 16 MiB · ${mbps(bytes * 8 / Math.max(1, elapsedMs) / 1000)} Mbps so far`;
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
    $('start').textContent = 'Test finished';
    $('test-state').textContent = report.status === 'completed' ? 'TEST COMPLETE' : 'PARTIAL RESULTS';
    $('progress-label').textContent = report.status === 'completed' ? 'All four samples complete' : 'Test ended. Partial results are useful too.';
    $('live-speed').textContent = 'Average speeds above use complete samples, including connection time.';
    $('outcome').hidden = false;
    const prod = summarize(report.samples, 'production');
    const comp = summarize(report.samples, 'comparison');
    $('outcome-text').textContent = report.status !== 'completed' ? 'Some samples did not finish. You can still submit the report, including any errors.'
      : prod && comp && comp / prod > 1.5 ? `The R2 development route was ${(comp / prod).toFixed(1)}× faster in this test. Send the report so we can compare it with other players.`
      : prod && comp && prod / comp > 1.5 ? `The production route was ${(prod / comp).toFixed(1)}× faster in this test. Send the report so we can compare it with other players.`
      : 'The two routes had similar speeds in this test. Your result is still useful.';
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
    $('submit-status').textContent = 'Saved. Thanks for helping us investigate.';
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
    notice('Please open this page on the desktop computer you use for Minecraft. Mobile connections would measure a different route.');
    $('start').textContent = 'Desktop computer required';
  } else if (!window.isSecureContext || !crypto.randomUUID || !window.ReadableStream) {
    notice('Use a current desktop browser over HTTPS, or localhost for local testing.');
    $('start').textContent = 'Browser update required';
  } else {
    $('start').disabled = false;
    $('start').textContent = 'Start download test';
  }
  for (const endpoint of config.endpoints) $(`${endpoint.id}-host`).textContent = new URL(endpoint.url).hostname;
  if (!config.submissionsAvailable) notice('Result storage is not configured yet. You can run the test and save a local report.');
  void refreshContext();
} catch (error) { notice(error.message); $('start').textContent = 'Unable to load test'; }
