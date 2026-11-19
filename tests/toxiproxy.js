const API = process.env.TOXIPROXY_API || 'http://localhost:8474';
const PROXY = 'backend_proxy';
const LISTEN = '0.0.0.0:8666';
const UPSTREAM = process.env.UPSTREAM || 'backend:3000';

async function call(method, path, body, okStatuses = [200, 201, 204]) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!okStatuses.includes(res.status)) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// Buat proxy (hapus dulu jika sudah ada)
async function createProxy() {
  await call('DELETE', `/proxies/${PROXY}`, null, [204, 404]);
  return call('POST', '/proxies', { name: PROXY, listen: LISTEN, upstream: UPSTREAM, enabled: true });
}

// Tambah toxic. stream: 'downstream' (respons ke klien) atau 'upstream' (request ke backend)
const addToxic = (name, type, attributes, { stream = 'downstream', toxicity = 1.0 } = {}) =>
  call('POST', `/proxies/${PROXY}/toxics`, { name, type, stream, toxicity, attributes });

// Nyalakan/matikan proxy (matikan = simulasi layanan mati total)
const setEnabled = (enabled) => call('POST', `/proxies/${PROXY}`, { enabled });

// Hapus semua toxic dan aktifkan semua proxy
const reset = () => call('POST', '/reset', null, [200, 204]);

const status = () => call('GET', `/proxies/${PROXY}`);

module.exports = { createProxy, addToxic, setEnabled, reset, status };
