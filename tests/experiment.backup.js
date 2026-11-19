const fs = require('fs');
const path = require('path');
const toxiproxy = require('./toxiproxy');
const { CircuitBreaker, NaiveClient, ResilientClient, sleep } = require('../client/clients');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8666';
const REQUESTS = Number(process.env.REQUESTS || 10);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 200);
const ENDPOINT = '/api/products';

const scenarios = [
  { id: 'S0', name: 'Baseline (tanpa gangguan)', setup: async () => {} },
  { id: 'S1', name: 'Latency ringan 300 ms', setup: () => toxiproxy.addToxic('lat_300', 'latency', { latency: 300, jitter: 50 }) },
  { id: 'S2', name: 'Latency berat 2500 ms', setup: () => toxiproxy.addToxic('lat_2500', 'latency', { latency: 2500, jitter: 200 }) },
  { id: 'S3', name: 'Timeout / koneksi menggantung', setup: () => toxiproxy.addToxic('hang', 'timeout', { timeout: 0 }) },
  { id: 'S4', name: 'Intermiten: reset 50%', setup: () => toxiproxy.addToxic('reset50', 'reset_peer', { timeout: 0 }, { toxicity: 0.5 }) },
  { id: 'S5', name: 'Service down (proxy mati)', setup: () => toxiproxy.setEnabled(false) },
];

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function newResilientClient() {
  return new ResilientClient({
    baseUrl: PROXY_URL,
    timeoutMs: 1000,
    maxRetries: 2,
    backoffMs: 200,
    breaker: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 }),
  });
}

function summarize(scenario, mode, results, client) {
  const total = results.length;
  const live = results.filter((r) => r.source === 'live').length;
  const cache = results.filter((r) => r.source === 'cache').length;
  const failed = results.filter((r) => !r.ok).length;
  const lat = results.map((r) => r.latencyMs);
  const avg = lat.reduce((a, b) => a + b, 0) / total;
  const attempts = results.reduce((a, r) => a + r.attempts, 0) / total;
  return {
    scenario: scenario.id,
    name: scenario.name,
    mode,
    total,
    live,
    cache,
    failed,
    live_success_pct: +((live / total) * 100).toFixed(1),
    served_pct: +(((live + cache) / total) * 100).toFixed(1),
    avg_ms: Math.round(avg),
    p95_ms: percentile(lat, 95),
    max_ms: Math.max(...lat),
    avg_attempts: +attempts.toFixed(2),
    breaker_state: client.breaker ? client.breaker.state : '-',
  };
}

async function runScenario(scenario, mode) {
  await toxiproxy.reset();
  const client = mode === 'resilient' ? newResilientClient() : new NaiveClient({ baseUrl: PROXY_URL, timeoutMs: 3000 });

  await client.get(ENDPOINT); // request pemanasan: mengisi cache klien resilient
  await scenario.setup();

  const results = [];
  for (let i = 0; i < REQUESTS; i++) {
    const r = await client.get(ENDPOINT);
    results.push(r);
    console.log(`  #${i + 1} source=${r.source} ok=${r.ok} attempts=${r.attempts} ${r.latencyMs}ms${r.reason ? ' reason=' + r.reason : ''}`);
    await sleep(INTERVAL_MS);
  }
  await toxiproxy.reset();
  return summarize(scenario, mode, results, client);
}

async function recoveryTest() {
  console.log('\n=== TC-07 Recoverability ===');
  await toxiproxy.reset();
  const client = newResilientClient();
  await client.get(ENDPOINT); // isi cache

  await toxiproxy.setEnabled(false);
  console.log('Outage dimulai (proxy dimatikan)...');
  for (let i = 0; i < 6; i++) {
    const r = await client.get(ENDPOINT);
    console.log(`  outage #${i + 1} source=${r.source} breaker=${client.breaker.state} ${r.latencyMs}ms`);
    await sleep(200);
  }
  const breakerDuringOutage = client.breaker.state;

  await toxiproxy.setEnabled(true);
  const restoredAt = Date.now();
  console.log('Layanan dipulihkan. Menunggu klien kembali memperoleh respons live...');

  let recoveryMs = null;
  while (Date.now() - restoredAt < 30000) {
    const r = await client.get(ENDPOINT);
    console.log(`  recovery source=${r.source} breaker=${client.breaker.state}`);
    if (r.source === 'live') {
      recoveryMs = Date.now() - restoredAt;
      break;
    }
    await sleep(250);
  }
  return { breaker_during_outage: breakerDuringOutage, recovery_ms: recoveryMs };
}

function toCsv(rows) {
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
}

async function main() {
  try {
    await toxiproxy.createProxy();
  } catch (e) {
    console.error('Gagal terhubung ke Toxiproxy:', e.message);
    console.error('Jalankan dulu: docker compose up -d --build');
    process.exit(1);
  }

  const all = [];
  for (const s of scenarios) {
    for (const mode of ['naive', 'resilient']) {
      console.log(`\n>>> ${s.id} - ${s.name} [${mode}]`);
      all.push(await runScenario(s, mode));
    }
  }

  console.log('\n=== RINGKASAN ===');
  console.table(all.map(({ scenario, mode, live_success_pct, served_pct, failed, avg_ms, p95_ms, avg_attempts, breaker_state }) =>
    ({ scenario, mode, live_success_pct, served_pct, failed, avg_ms, p95_ms, avg_attempts, breaker_state })));

  const recovery = await recoveryTest();
  console.log('\nHasil recoverability:', recovery);

  const outDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ scenarios: all, recovery }, null, 2));
  fs.writeFileSync(path.join(outDir, 'results.csv'), toCsv(all));
  console.log(`\nHasil disimpan di ${outDir} (results.json dan results.csv)`);
  await toxiproxy.reset();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
