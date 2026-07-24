const { BookAIService } = require('../backend/ai/service');
const { ProviderRouter, LocalRetrievalProvider } = require('../backend/ai/providers');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const locator = (blockId, sourceOrdinal) => ({
  version: 2,
  parserVersion: 'publication-v4',
  chapterId: 'c1',
  blockId,
  sourceOrdinal,
  textQuote: blockId,
});

async function unitChecks() {
  const publication = {
    bookId: 'otn-test',
    title: 'OTN 原理与技术',
    chapters: [{
      id: 'c1',
      title: '网络保护',
      blocks: [
        { id: 'b1', type: 'heading', text: 'OTN 网络保护', locator: locator('b1', 0) },
        { id: 'b2', type: 'p', text: '保护倒换通过预先规划的备用路径，在工作路径失效时恢复业务。', locator: locator('b2', 1) },
        { id: 'b3', type: 'image', caption: '保护倒换流程图', alt: '工作路径与保护路径', locator: locator('b3', 2) },
      ],
    }],
  };

  const recorded = [];
  const service = new BookAIService({ recordRun: (run) => recorded.push(run) });
  const answer = await service.ask({ question: 'OTN 如何实现保护倒换？', mode: 'deep', bookIds: ['otn-test'] }, [publication]);
  assert(!answer.refused, 'grounded question should be answered');
  assert(answer.sources.length > 0, 'answer should contain evidence');
  assert(answer.sources.every((source) => source.locator?.blockId), 'every citation should have a locator');
  assert(answer.verification.supportedClaims === answer.claims.length, 'all returned claims must be verified');
  assert(recorded.length === 1 && recorded[0].bookIds[0] === 'otn-test', 'run should be observable and multi-book ready');

  const hallucinatingProviders = {
    capabilities: () => ({ activeProvider: 'fake', remoteConfigured: true, fallbackProvider: 'none', modes: ['quick', 'deep'] }),
    answer: async () => ({ provider: 'fake', fallback: false, candidate: { answer: '火星上有 OTN。', claims: [{ text: '火星上有 OTN。', citationIds: ['NOT_FOUND'] }] } }),
  };
  const guarded = new BookAIService({ providers: hallucinatingProviders });
  const rejected = await guarded.ask({ question: 'OTN 保护倒换是什么？', bookIds: ['otn-test'] }, [publication]);
  assert(rejected.refused && rejected.refusalReason === 'verification_failed', 'unsupported model output must be refused');

  const router = new ProviderRouter({
    remote: { id: 'broken-remote', answer: async () => { throw new Error('network unavailable'); } },
    local: new LocalRetrievalProvider(),
  });
  const fallbackService = new BookAIService({ providers: router });
  const fallback = await fallbackService.ask({ question: '保护倒换如何恢复业务？', bookIds: ['otn-test'] }, [publication]);
  assert(fallback.fallback && fallback.provider === 'local-extractive', 'remote failure must fall back locally');
  return { grounded: true, citationGuard: true, providerSwap: true, localFallback: true };
}

async function apiChecks() {
  const base = process.env.COREADING_BASE_URL || 'http://127.0.0.1:3030';
  let health;
  try {
    health = await fetch(`${base}/api/health`).then((response) => response.json());
  } catch {
    return { skipped: true, reason: `server unavailable at ${base}` };
  }
  assert(health.version >= 8 && health.bookAI?.architecture, 'iteration 8 server is not running');
  const books = await fetch(`${base}/api/books`).then((response) => response.json());
  const book = books.find((item) => /OTN|光传送网/i.test(item.title));
  assert(book, 'OTN test book not found');
  const toc = await fetch(`${base}/api/books/${book.id}/toc`).then((response) => response.json());
  const cases = (toc.toc || []).filter((item) => item.locator && item.title.replace(/\s+/g, '').length >= 4).slice(0, 80);
  assert(cases.length >= 80, `expected 80 OTN evaluation cases, received ${cases.length}`);
  let hits = 0;
  let cited = 0;
  for (const item of cases) {
    const response = await fetch(`${base}/api/books/${book.id}/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: `请说明“${item.title}”`, mode: 'quick', useCurrentLocation: false }),
    });
    const payload = await response.json();
    assert(response.ok, payload.error || 'assistant request failed');
    if (payload.sources?.some((source) => source.locator?.chapterId === item.locator.chapterId)) hits += 1;
    if (payload.sources?.every((source) => source.locator?.blockId)) cited += 1;
  }
  const recallAt10 = hits / cases.length;
  const locatorCoverage = cited / cases.length;
  assert(recallAt10 >= 0.9, `Recall target missed: ${recallAt10}`);
  assert(locatorCoverage === 1, `Locator coverage target missed: ${locatorCoverage}`);
  const unknown = await fetch(`${base}/api/books/${book.id}/assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'zzqv9876完全不存在的火星农业术语', mode: 'quick' }),
  }).then((response) => response.json());
  assert(unknown.refused, 'unanswerable question should be refused');
  return { cases: cases.length, recallAt10, locatorCoverage, refusal: true };
}

(async () => {
  const unit = await unitChecks();
  const api = await apiChecks();
  console.log(JSON.stringify({ ok: true, unit, api }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
