const crypto = require('crypto');
const { cleanText } = require('./contracts');

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function createError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createError('WorkAgent 请求已取消', 'WORKAGENT_CANCELLED'));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createError('WorkAgent 请求已取消', 'WORKAGENT_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 30000, externalSignal = null) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs) || 30000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let payload = null;
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    }
    if (!response.ok) {
      const detail = payload?.detail || payload?.error || payload?.raw || response.statusText;
      throw createError(
        `WorkAgent API ${response.status}: ${cleanText(detail, 400)}`,
        'WORKAGENT_HTTP_ERROR',
        { status: response.status }
      );
    }
    return payload || {};
  } catch (error) {
    if (externalSignal?.aborted) throw createError('WorkAgent 请求已取消', 'WORKAGENT_CANCELLED');
    if (timedOut) throw createError(`WorkAgent 请求超时（${timeoutMs}ms）`, 'WORKAGENT_TIMEOUT');
    if (error?.code) throw error;
    throw createError(`无法连接 WorkAgent：${cleanText(error.message, 300)}`, 'WORKAGENT_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

class WorkAgentClient {
  constructor(options = {}) {
    this.enabled = options.enabled ?? envFlag(process.env.WORKAGENT_ENABLED, true);
    this.baseUrl = String(options.baseUrl || process.env.WORKAGENT_BASE_URL || 'http://127.0.0.1:8766').replace(/\/+$/, '');
    this.sharedSecret = String(options.sharedSecret ?? process.env.WORKAGENT_SHARED_SECRET ?? '');
    this.quickModel = String(options.quickModel || process.env.WORKAGENT_QUICK_MODEL || process.env.WORKAGENT_MODEL || 'deepseek:deepseek-chat');
    this.deepModel = String(options.deepModel || process.env.WORKAGENT_DEEP_MODEL || process.env.WORKAGENT_MODEL || 'deepseek:deepseek-reasoner');
    this.quickTimeoutMs = Number(options.quickTimeoutMs || process.env.WORKAGENT_QUICK_TIMEOUT_MS || 35000);
    this.deepTimeoutMs = Number(options.deepTimeoutMs || process.env.WORKAGENT_DEEP_TIMEOUT_MS || 120000);
    this.healthTimeoutMs = Number(options.healthTimeoutMs || process.env.WORKAGENT_HEALTH_TIMEOUT_MS || 1200);
    this.pollIntervalMs = Number(options.pollIntervalMs || process.env.WORKAGENT_POLL_INTERVAL_MS || 1000);
    this.healthCacheMs = Number(options.healthCacheMs || 10000);
    this.circuitBreakMs = Number(options.circuitBreakMs || 30000);
    this.asyncDeep = options.asyncDeep ?? envFlag(process.env.WORKAGENT_ASYNC_DEEP, true);
    this.state = {
      online: null,
      lastCheckedAt: null,
      lastError: '',
      circuitOpenUntil: 0,
    };
  }

  capabilities() {
    return {
      enabled: this.enabled,
      online: this.state.online,
      baseUrl: this.baseUrl,
      quickModel: this.quickModel,
      deepModel: this.deepModel,
      asyncDeep: this.asyncDeep,
      signatureConfigured: Boolean(this.sharedSecret),
      lastCheckedAt: this.state.lastCheckedAt,
      lastError: this.state.lastError || null,
      circuitOpen: Date.now() < this.state.circuitOpenUntil,
    };
  }

  modelFor(mode) {
    return mode === 'deep' ? this.deepModel : this.quickModel;
  }

  async health({ force = false, signal = null } = {}) {
    if (!this.enabled) return { ...this.capabilities(), online: false, reason: 'disabled' };
    const checkedAt = this.state.lastCheckedAt ? Date.parse(this.state.lastCheckedAt) : 0;
    if (!force && this.state.online !== null && Date.now() - checkedAt < this.healthCacheMs) return this.capabilities();
    if (!force && Date.now() < this.state.circuitOpenUntil) return this.capabilities();
    try {
      await fetchJson(
        `${this.baseUrl}/api/gateway/v1/policies/channels`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        this.healthTimeoutMs,
        signal
      );
      this.state = { online: true, lastCheckedAt: new Date().toISOString(), lastError: '', circuitOpenUntil: 0 };
    } catch (error) {
      if (error?.code === 'WORKAGENT_CANCELLED') throw error;
      this._markFailure(error);
    }
    return this.capabilities();
  }

  async run({ content, mode = 'quick', taskId, userId = 'local-user', tenantId = 'local', requestId, signal = null }) {
    if (!this.enabled) throw createError('WorkAgent 未启用', 'WORKAGENT_DISABLED');
    const health = await this.health({ signal });
    if (!health.online) {
      throw createError(
        health.lastError || 'WorkAgent 当前离线',
        'WORKAGENT_UNAVAILABLE',
        { circuitOpen: health.circuitOpen }
      );
    }
    const asyncMode = mode === 'deep' && this.asyncDeep;
    const body = {
      content,
      task_id: taskId,
      model: this.modelFor(mode),
      channel: 'co-reading',
      tenant_id: tenantId,
      user_id: userId,
      auto_confirm: false,
      async_mode: asyncMode,
      request_id: requestId,
    };
    try {
      const started = Date.now();
      const initial = await this._postMessage(body, signal);
      const result = asyncMode ? await this._pollJob(initial.job_id, started, signal) : initial;
      const assistantMessage = String(result.assistant_message || result.result?.assistant_message || '').trim();
      if (!assistantMessage) throw createError('WorkAgent 返回了空回答', 'WORKAGENT_EMPTY_RESPONSE');
      this.state = { online: true, lastCheckedAt: new Date().toISOString(), lastError: '', circuitOpenUntil: 0 };
      return {
        assistantMessage,
        traceId: result.trace_id || initial.trace_id || requestId,
        taskId: result.task_id || initial.task_id || taskId,
        jobId: initial.job_id || null,
        model: body.model,
        status: result.status || initial.status || 'idle',
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      if (error.code !== 'WORKAGENT_CANCELLED') this._markFailure(error);
      throw error;
    }
  }

  async _postMessage(body, signal) {
    const rawBody = JSON.stringify(body);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.sharedSecret) {
      const digest = crypto.createHmac('sha256', this.sharedSecret).update(rawBody).digest('hex');
      headers['X-Workbench-Signature'] = `sha256=${digest}`;
    }
    return fetchJson(
      `${this.baseUrl}/api/gateway/v1/messages`,
      { method: 'POST', headers, body: rawBody },
      Math.min(this.quickTimeoutMs, this.deepTimeoutMs),
      signal
    );
  }

  async _pollJob(jobId, started, signal) {
    if (!jobId) throw createError('WorkAgent 深度任务缺少 job_id', 'WORKAGENT_INVALID_JOB');
    while (Date.now() - started < this.deepTimeoutMs) {
      await wait(this.pollIntervalMs, signal);
      const job = await fetchJson(
        `${this.baseUrl}/api/gateway/v1/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        Math.min(10000, this.quickTimeoutMs),
        signal
      );
      if (job.status === 'completed') return job.result || job;
      if (job.status === 'failed') {
        throw createError(`WorkAgent 深度任务失败：${cleanText(job.error_text, 400)}`, 'WORKAGENT_JOB_FAILED');
      }
    }
    throw createError(`WorkAgent 深度任务超时（${this.deepTimeoutMs}ms）`, 'WORKAGENT_TIMEOUT');
  }

  _markFailure(error) {
    this.state = {
      online: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: cleanText(error?.message || 'WorkAgent unavailable', 400),
      circuitOpenUntil: Date.now() + this.circuitBreakMs,
    };
  }
}

module.exports = { WorkAgentClient, fetchJson, envFlag };
