const { cleanText, refusal } = require('./contracts');
const { WorkAgentProvider } = require('./workagent-provider');

class LocalRetrievalProvider {
  constructor() { this.id = 'local-extractive'; }

  async answer(_plan, contextPackage) {
    if (!contextPackage.evidence.length) return refusal();
    const evidence = contextPackage.evidence.slice(0, contextPackage.mode === 'deep' ? 5 : 3);
    const claims = evidence.map((item) => ({
      text: cleanText(item.excerpt, 260),
      citationIds: [item.id],
    }));
    return {
      answer: `本书中与问题最相关的内容可归纳为以下 ${claims.length} 点：${claims.map((claim, index) => `${index + 1}. ${claim.text}`).join(' ')}`,
      claims,
      providerNotice: '当前使用本地证据整理；配置 DeepSeek 后可生成更系统的综合回答。',
    };
  }
}

class DeepSeekProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = options.model || 'deepseek-chat';
    this.timeoutMs = Number(options.timeoutMs || 45000);
    this.id = `deepseek:${this.model}`;
  }

  async answer(plan, contextPackage) {
    if (!this.apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');
    const system = [
      '你是严谨的书内研究助手。只能使用给定证据，禁止补充常识或猜测。',
      '每个关键主张必须关联一个或多个证据编号；证据不足时明确拒答。',
      '返回严格 JSON：{"answer":"...","claims":[{"text":"...","citationIds":["E1"]}]}。',
      '引用编号只能使用输入中出现的 E 编号。',
    ].join('\n');
    const user = `问题：${plan.question}\n回答模式：${plan.mode}\n意图：${plan.intent}\n\n书内证据：\n${contextPackage.rendered}`;
    const controller = new AbortController();
    const abortFromPlan = () => controller.abort();
    if (plan.signal?.aborted) controller.abort();
    plan.signal?.addEventListener('abort', abortFromPlan, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${cleanText(await response.text(), 300)}`);
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek returned an empty answer');
      return JSON.parse(content);
    } catch (error) {
      if (plan.signal?.aborted) {
        const cancelled = new Error('问书请求已取消');
        cancelled.code = 'WORKAGENT_CANCELLED';
        throw cancelled;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      plan.signal?.removeEventListener('abort', abortFromPlan);
    }
  }
}

class ProviderRouter {
  constructor(options = {}) {
    this.local = options.local || new LocalRetrievalProvider();
    const customProviders = Object.prototype.hasOwnProperty.call(options, 'remote')
      || Object.prototype.hasOwnProperty.call(options, 'local');
    this.workagent = Object.prototype.hasOwnProperty.call(options, 'workagent')
      ? options.workagent
      : customProviders ? null : new WorkAgentProvider(options.workagentOptions);
    this.remote = options.remote || (process.env.DEEPSEEK_API_KEY ? new DeepSeekProvider({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      model: process.env.DEEPSEEK_MODEL,
      timeoutMs: process.env.DEEPSEEK_TIMEOUT_MS,
    }) : null);
  }

  capabilities() {
    const workagent = this.workagent?.capabilities?.() || {
      id: 'workagent',
      enabled: false,
      online: false,
    };
    return {
      activeProvider: workagent.enabled ? 'workagent' : this.remote?.id || this.local.id,
      workagent,
      remoteConfigured: Boolean(this.remote),
      directProvider: this.remote?.id || null,
      fallbackProvider: this.local.id,
      fallbackChain: [
        ...(workagent.enabled ? ['workagent'] : []),
        ...(this.remote ? [this.remote.id] : []),
        this.local.id,
      ],
      modes: ['quick', 'deep'],
    };
  }

  async probeCapabilities() {
    if (this.workagent?.probe) await this.workagent.probe();
    return this.capabilities();
  }

  async answer(plan, contextPackage) {
    const failures = [];
    if (this.workagent?.configured?.()) {
      try {
        const candidate = await this.workagent.answer(plan, contextPackage);
        const trace = candidate?._workagent || {};
        return {
          candidate,
          provider: `workagent:${trace.model || 'auto'}`,
          fallback: false,
          fallbackFrom: [],
          trace,
        };
      } catch (error) {
        if (error?.code === 'WORKAGENT_CANCELLED') throw error;
        failures.push({ provider: 'workagent', error: cleanText(error.message, 400), code: error.code || null });
      }
    }
    if (this.remote) {
      try {
        return {
          candidate: await this.remote.answer(plan, contextPackage),
          provider: this.remote.id,
          fallback: failures.length > 0,
          fallbackFrom: failures.map((item) => item.provider),
          providerError: failures.map((item) => `${item.provider}: ${item.error}`).join(' | ') || null,
        };
      } catch (error) {
        if (error?.code === 'WORKAGENT_CANCELLED') throw error;
        failures.push({ provider: this.remote.id, error: cleanText(error.message, 400), code: error.code || null });
      }
    }
    const candidate = await this.local.answer(plan, contextPackage);
    if (failures.length) {
      candidate.providerNotice = `智能服务暂时不可用，已自动降级为本地证据整理。${failures[0].error ? ` 原因：${failures[0].error}` : ''}`;
    }
    return {
      candidate,
      provider: this.local.id,
      fallback: failures.length > 0,
      fallbackFrom: failures.map((item) => item.provider),
      providerError: failures.map((item) => `${item.provider}: ${item.error}`).join(' | ') || null,
    };
  }
}

module.exports = { DeepSeekProvider, LocalRetrievalProvider, ProviderRouter };
