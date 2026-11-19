const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function classify(err) {
  if (err.name === 'AbortError') return 'timeout';
  if (err.message && err.message.startsWith('HTTP')) return err.message;
  return 'network_error';
}

// ---------- Circuit Breaker ----------
class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 5000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
  }
  canRequest() {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }
  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  onFailure() {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}

// ---------- Klien TANPA mekanisme ketahanan ----------
class NaiveClient {
  constructor({ baseUrl, timeoutMs = 3000 }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.breaker = null;
  }
  async get(path) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return { ok: true, source: 'live', attempts: 1, latencyMs: Date.now() - start, data };
    } catch (err) {
      return { ok: false, source: 'none', reason: classify(err), attempts: 1, latencyMs: Date.now() - start, data: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------- Klien DENGAN timeout + retry + circuit breaker + fallback cache ----------
class ResilientClient {
  constructor({ baseUrl, timeoutMs = 1000, maxRetries = 2, backoffMs = 200, breaker }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
    this.breaker = breaker || new CircuitBreaker();
    this.cache = null;
  }

  async _fetchOnce(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  _fallback(start, reason, attempts) {
    const latencyMs = Date.now() - start;
    if (this.cache) {
      return { ok: true, source: 'cache', degraded: true, reason, attempts, latencyMs, data: this.cache };
    }
    return { ok: false, source: 'none', reason, attempts, latencyMs, data: null };
  }

  async get(path) {
    const start = Date.now();

    // Circuit OPEN: langsung fallback, tidak menyentuh backend.
    if (!this.breaker.canRequest()) {
      return this._fallback(start, 'circuit_open', 0);
    }

    let lastReason = 'unknown';
    let attempts = 0;
    for (let i = 0; i <= this.maxRetries; i++) {
      attempts += 1;
      try {
        const data = await this._fetchOnce(path);
        this.breaker.onSuccess();
        this.cache = data;
        return { ok: true, source: 'live', attempts, latencyMs: Date.now() - start, data };
      } catch (err) {
        lastReason = classify(err);
        if (i < this.maxRetries) {
          await sleep(this.backoffMs * 2 ** i); // exponential backoff: 200ms, 400ms
        }
      }
    }
    // Semua percobaan gagal: hitung SATU kegagalan untuk circuit breaker.
    this.breaker.onFailure();
    return this._fallback(start, lastReason, attempts);
  }
}

module.exports = { CircuitBreaker, NaiveClient, ResilientClient, sleep };
