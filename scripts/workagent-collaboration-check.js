const crypto = require('crypto');
const http = require('http');
const { AnswerNormalizer } = require('../backend/ai/answer-normalizer');
const { ReaderContextAdapter } = require('../backend/ai/reader-context-adapter');
const { WorkAgentClient } = require('../backend/ai/workagent-client');
const { WorkAgentProvider } = require('../backend/ai/workagent-provider');
const { ProviderRouter, LocalRetrievalProvider } = require('../backend/ai/providers');
const { BookAIService } = require('../backend/ai/service');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fixture() {
  const locator = {
    chapterId: 'c6',
    blockId: 'b18',
    sourceOrdinal: 18,
    textQuote: '保护倒换通过备用路径恢复业务',
  };
  const plan = {
    id: 'wa-check-1',
    question: 'OTN 如何实现保护倒换？',
    mode: 'quick',
    intent: 'explain',
    bookIds: ['otn'],
    userId: 'reader-1',
    activeLocator: locator,
  };
  const contextPackage = {
    mode: 'quick',
    evidence: [{
      id: 'E1',
      bookId: 'otn',
      bookTitle: 'OTN 原理与技术',
      chapterId: 'c6',
      chapterTitle: '网络保护',
      blockId: 'b18',
      kind: 'text',
      excerpt: '保护倒换通过预先规划的备用路径，在工作路径失效时恢复业务。',
      context: '工作路径承载正常业务。保护倒换通过预先规划的备用路径，在工作路径失效时恢复业务。',
      locator,
    }],
    readingContext: {
      books: [{ id: 'otn', title: 'OTN 原理与技术', author: '测试作者', format: 'EPUB' }],
      activeLocator: locator,
      selectedText: '保护倒换',
      toc: [{ bookId: 'otn', title: '网络保护', level: 1, locator }],
      notes: [{ text: '保护路径需要预先规划', locator }],
    },
  };
  return { plan, contextPackage };
}

async function withMockWorkAgent(run) {
  const secret = 'wa-test-secret';
  const state = { requests: [], polls: 0 };
  const answer = JSON.stringify({
    answer: 'OTN 在工作路径失效时切换到预先规划的备用路径以恢复业务。',
    claims: [{ text: '保护倒换使用预先规划的备用路径恢复业务。', citationIds: ['E1'] }],
    expandedUnderstanding: '可以把工作路径和保护路径理解为主用与备用通道。',
    externalExtension: '',
    externalSources: [],
    limitations: ['当前证据没有给出倒换时间。'],
    followUpQuestions: ['保护倒换的触发条件有哪些？'],
  });
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/gateway/v1/policies/channels') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ gateway: {} }));
    }
    if (req.method === 'GET' && req.url === '/api/gateway/v1/jobs/job-deep') {
      state.polls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.polls < 2
        ? { id: 'job-deep', status: 'running' }
        : { id: 'job-deep', status: 'completed', result: { assistant_message: answer, trace_id: 'trace-deep', task_id: 'task-deep', status: 'idle' } }));
    }
    if (req.method === 'POST' && req.url === '/api/gateway/v1/messages') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      return req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        state.requests.push({ raw, signature: req.headers['x-workbench-signature'] });
        const body = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body.async_mode
          ? { ok: true, job_id: 'job-deep', trace_id: body.request_id, task_id: body.task_id, status: 'queued' }
          : { ok: true, assistant_message: answer, trace_id: body.request_id, task_id: body.task_id, status: 'idle' }));
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      secret,
      state,
      expectedAnswer: answer,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function checks() {
  const normalizer = new AnswerNormalizer();
  const normalized = normalizer.normalize('```json\n{"answer":"结论","claims":[{"text":"备用路径恢复业务","citationIds":["E1"]}]}\n```');
  assert(normalized.claims[0].citationIds[0] === 'E1', 'fenced JSON should be normalized');
  const workagentNative = normalizer.normalize(JSON.stringify({
    answer: 'ITU-T SG15 推动相关标准化工作。',
    claims: [
      { claim: 'SG15推动超100G OTN标准化。', evidence: ['E1'] },
      { statement: 'SG15定义POTN设备模型。', refs: [{ id: 'E3' }] },
    ],
    limitations: '书中仅覆盖部分事件。',
  }));
  assert(workagentNative.claims.length === 2, 'WorkAgent claim/evidence schema should be normalized');
  assert(workagentNative.claims[0].text.includes('SG15') && workagentNative.claims[0].citationIds[0] === 'E1', 'claim/evidence aliases should preserve grounding');
  assert(workagentNative.claims[1].citationIds[0] === 'E3', 'object evidence references should be normalized');
  assert(workagentNative.limitations.length === 1, 'string limitations should become a list');
  assert(workagentNative._agentPayload.claims[0].claim.includes('SG15'), 'the WorkAgent payload should remain available for display');
  const uncited = normalizer.normalize('没有任何引用的普通回答');
  assert(uncited.answer === '没有任何引用的普通回答' && uncited.claims.length === 0, 'a non-empty WorkAgent answer must not trigger fallback');
  const uncitedClaim = normalizer.normalize('{"answer":"结论","claims":[{"claim":"没有证据编号的主张","evidence":[]}]}');
  assert(uncitedClaim.claims[0].text === '没有证据编号的主张', 'WorkAgent claims should remain visible even when evidence references are absent');

  const { plan, contextPackage } = fixture();
  const adapted = new ReaderContextAdapter().build(plan, contextPackage);
  assert(adapted.prompt.includes('coreading://book/otn/chapter/c6/block/b18'), 'reader locator should become a stable source URI');
  assert(adapted.prompt.includes('保护路径需要预先规划'), 'related notes should be included');
  assert(adapted.payload.outputContract.claims[0].claim && adapted.payload.outputContract.claims[0].evidence[0] === 'E1', 'context contract should use WorkAgent claim/evidence fields');
  assert(adapted.taskId.startsWith('coreading_'), 'reader session should use an isolated WorkAgent task');
  const contextWithNullLocators = {
    ...contextPackage,
    readingContext: {
      ...contextPackage.readingContext,
      activeLocator: null,
      toc: [...contextPackage.readingContext.toc, { bookId: 'otn', title: '无定位目录', locator: null }],
    },
  };
  const nullSafe = new ReaderContextAdapter().build({ ...plan, activeLocator: null }, contextWithNullLocators);
  assert(nullSafe.payload.readingState.activeLocator.chapterId === null, 'missing active/toc locators must not break WorkAgent context');

  await withMockWorkAgent(async ({ baseUrl, secret, state }) => {
    const client = new WorkAgentClient({
      enabled: true,
      baseUrl,
      sharedSecret: secret,
      quickModel: 'deepseek:deepseek-chat',
      deepModel: 'deepseek:deepseek-reasoner',
      healthTimeoutMs: 500,
      quickTimeoutMs: 2000,
      deepTimeoutMs: 3000,
      pollIntervalMs: 10,
      healthCacheMs: 100,
    });
    const provider = new WorkAgentProvider({ client });
    const quick = await provider.answer(plan, contextPackage);
    assert(quick.claims[0].citationIds[0] === 'E1', 'WorkAgent provider should return normalized citations');
    assert(quick.expandedUnderstanding, 'WorkAgent provider should preserve expanded understanding');
    const expectedSignature = `sha256=${crypto.createHmac('sha256', secret).update(state.requests[0].raw).digest('hex')}`;
    assert(state.requests[0].signature === expectedSignature, 'gateway request must use the exact-body HMAC signature');

    const deep = await provider.answer({ ...plan, id: 'wa-check-deep', mode: 'deep' }, contextPackage);
    assert(deep._workagent.jobId === 'job-deep' && state.polls >= 2, 'deep mode should poll the asynchronous WorkAgent job');
    assert(JSON.parse(state.requests[1].raw).model === 'deepseek:deepseek-reasoner', 'deep mode should select the configured reasoning model');
  });

  const failures = [];
  const router = new ProviderRouter({
    workagent: {
      configured: () => true,
      capabilities: () => ({ enabled: true, online: false }),
      answer: async () => { failures.push('workagent'); throw new Error('offline'); },
    },
    remote: {
      id: 'deepseek:test',
      answer: async () => ({
        answer: '备用路径恢复业务。',
        claims: [{ text: '备用路径恢复业务。', citationIds: ['E1'] }],
      }),
    },
    local: new LocalRetrievalProvider(),
  });
  const routed = await router.answer(plan, contextPackage);
  assert(routed.provider === 'deepseek:test' && routed.fallback, 'WorkAgent failure should fall back to direct DeepSeek');
  assert(routed.fallbackFrom.includes('workagent') && failures.length === 1, 'fallback diagnostics should name WorkAgent');

  const service = new BookAIService({
    providers: {
      capabilities: () => ({ activeProvider: 'workagent', modes: ['quick', 'deep'] }),
      answer: async () => ({
        provider: 'workagent:deepseek:deepseek-reasoner',
        fallback: false,
        fallbackFrom: [],
        trace: { traceId: 'trace-1', taskId: 'task-1' },
        candidate: {
          answer: '保护倒换通过备用路径恢复业务。',
          claims: [{ text: '保护倒换通过备用路径恢复业务。', citationIds: ['E1'] }],
          expandedUnderstanding: '主备通道是理解该机制的一个类比。',
          limitations: ['未给出倒换时间。'],
          workagentProtocol: 'reader-collaboration-v1',
          _agentPayload: {
            answer: '保护倒换通过备用路径恢复业务。',
            claims: [{ claim: '保护倒换通过备用路径恢复业务。', evidence: ['E1'] }],
          },
        },
      }),
    },
  });
  const publication = {
    bookId: 'otn',
    title: 'OTN 原理与技术',
    chapters: [{
      id: 'c6',
      title: '网络保护',
      blocks: [{
        id: 'b18',
        type: 'p',
        text: '保护倒换通过预先规划的备用路径，在工作路径失效时恢复业务。',
        locator: contextPackage.evidence[0].locator,
      }],
    }],
  };
  const result = await service.ask({
    question: plan.question,
    mode: 'deep',
    bookIds: ['otn'],
    userId: 'reader-1',
    readingContext: contextPackage.readingContext,
  }, [publication]);
  assert(!result.refused && result.provider.startsWith('workagent:'), 'BookAIService should accept a grounded WorkAgent answer');
  assert(result.understanding.expanded && result.diagnostics.traceId === 'trace-1', 'expanded understanding and trace should reach the API result');
  assert(result.agentResponse?.claims[0].evidence[0] === 'E1', 'the API should expose the aligned WorkAgent response');

  const permissiveService = new BookAIService({
    providers: {
      capabilities: () => ({ activeProvider: 'workagent', modes: ['quick', 'deep'] }),
      answer: async () => ({
        provider: 'workagent:deepseek:deepseek-reasoner',
        fallback: false,
        candidate: {
          answer: '这是 WorkAgent 已完成但未附带逐条引用的回答。',
          claims: [],
          workagentProtocol: 'reader-collaboration-v1',
        },
      }),
    },
  });
  const permissiveResult = await permissiveService.ask({
    question: plan.question,
    mode: 'deep',
    bookIds: ['otn'],
    userId: 'reader-1',
    readingContext: contextPackage.readingContext,
  }, [publication]);
  assert(!permissiveResult.refused && !permissiveResult.fallback, 'completed WorkAgent output must not be replaced by DeepSeek because citations are absent');
  assert(permissiveResult.answer.includes('WorkAgent 已完成'), 'completed WorkAgent output should be preserved');

  return {
    contextContract: true,
    nullLocatorSafety: true,
    answerNormalization: true,
    hmacSignature: true,
    asyncDeepMode: true,
    providerFallback: true,
    groundedServiceResult: true,
    completedWorkAgentPreserved: true,
  };
}

checks()
  .then((result) => console.log(JSON.stringify({ ok: true, checks: result }, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
