const crypto = require('crypto');
const { cleanText } = require('./contracts');

function compactLocator(locator = {}) {
  const value = locator || {};
  return {
    chapterId: value.chapterId || null,
    blockId: value.blockId || null,
    sourceAnchor: value.sourceAnchor || null,
    sourceOrdinal: Number.isFinite(Number(value.sourceOrdinal)) ? Number(value.sourceOrdinal) : null,
    page: value.page || null,
    assetId: value.assetId || null,
    textQuote: cleanText(value.textQuote || value.quote?.exact, 500) || null,
  };
}

function sourceUri(item) {
  const book = encodeURIComponent(item.bookId || 'unknown');
  const chapter = encodeURIComponent(item.chapterId || 'unknown');
  const block = encodeURIComponent(item.blockId || 'unknown');
  return `coreading://book/${book}/chapter/${chapter}/block/${block}`;
}

function relatedTocItems(contextPackage) {
  const readingContext = contextPackage.readingContext || {};
  const bookIds = new Set(contextPackage.evidence.map((item) => item.bookId).filter(Boolean));
  const chapterKeys = new Set(contextPackage.evidence
    .map((item) => `${item.bookId || ''}:${item.chapterId || ''}`));
  if (readingContext.activeLocator?.chapterId) {
    for (const bookId of bookIds) chapterKeys.add(`${bookId}:${readingContext.activeLocator.chapterId}`);
  }
  return (readingContext.toc || [])
    .filter((item) => chapterKeys.has(`${item.bookId || ''}:${item.locator?.chapterId || ''}`))
    .slice(0, 30)
    .map((item) => ({
      bookId: item.bookId || null,
      title: cleanText(item.title, 240),
      level: Number(item.level || 0),
      parentId: item.parentId || null,
      locator: compactLocator(item.locator),
    }));
}

class ReaderContextAdapter {
  constructor() {
    this.id = 'workagent-reader-context-v2';
  }

  build(plan, contextPackage) {
    const readingContext = contextPackage.readingContext || {};
    const evidence = contextPackage.evidence.map((item) => ({
      id: item.id,
      type: item.kind === 'image' ? 'book_figure' : 'book_passage',
      bookId: item.bookId,
      bookTitle: cleanText(item.bookTitle, 240),
      chapterTitle: cleanText(item.chapterTitle, 300),
      excerpt: cleanText(item.excerpt, 800),
      context: cleanText(item.context, plan.mode === 'deep' ? 2600 : 1400),
      sourceUri: sourceUri(item),
      locator: compactLocator(item.locator),
      trustLevel: 'primary_source',
    }));
    const notes = (readingContext.notes || []).slice(0, 8).map((note) => ({
      text: cleanText(note.text, 600),
      comment: cleanText(note.comment, 600),
      locator: compactLocator(note.locator),
    })).filter((note) => note.text || note.comment);
    const payload = {
      schemaVersion: 1,
      client: 'co-reading',
      requestId: plan.id,
      question: plan.question,
      questionSource: plan.questionSource,
      mode: plan.mode,
      intent: plan.intent,
      readingState: {
        books: (readingContext.books || []).slice(0, 8).map((book) => ({
          id: String(book.id || ''),
          title: cleanText(book.title, 240),
          author: cleanText(book.author, 160),
          format: cleanText(book.format, 30),
        })),
        activeLocator: compactLocator(readingContext.activeLocator || plan.activeLocator),
        selectedText: cleanText(readingContext.selectedText, 2400),
        contextAttachments: (readingContext.contextAttachments || []).slice(0, 5).map((attachment) => ({
          type: cleanText(attachment.type, 60),
          text: cleanText(attachment.text, 2400),
          bookId: attachment.bookId || null,
          bookTitle: cleanText(attachment.bookTitle, 240),
          chapterTitle: cleanText(attachment.chapterTitle, 300),
          locator: compactLocator(attachment.locator),
        })),
        relatedToc: relatedTocItems(contextPackage),
        relatedNotes: notes,
      },
      evidence,
      outputContract: {
        answer: '只概括书内证据直接支持的结论',
        claims: [{ claim: '书内主张', evidence: ['E1'] }],
        expandedUnderstanding: '基于证据作出的解释、联系、类比或推导；不得冒充原书原话',
        externalExtension: '仅在确有可识别来源时填写，否则为空字符串',
        externalSources: [{ title: '来源名', url: 'https://...', quote: '支持句' }],
        limitations: ['证据缺口或不确定性'],
        followUpQuestions: ['值得继续阅读的问题'],
      },
    };
    return {
      payload,
      prompt: this.renderPrompt(payload),
      taskId: this.taskId(plan),
    };
  }

  taskId(plan) {
    const identity = `${plan.userId || 'local-user'}|${[...plan.bookIds].sort().join('|') || 'library'}`;
    return `coreading_${crypto.createHash('sha1').update(identity).digest('hex').slice(0, 24)}`;
  }

  renderPrompt(payload) {
    const modeInstruction = payload.mode === 'deep'
      ? '进行系统化分析：先拆解问题，再综合不同章节证据，说明机制、关系、边界和证据缺口。'
      : '优先直接回答问题，保持简洁，但不得省略关键依据。';
    return [
      '[CO-READING READER COLLABORATION v1]',
      '你正在协助一个电子书阅读应用扩展用户理解。这不是文件生成、保存或代码任务。',
      modeInstruction,
      '硬性规则：',
      '1. answer 与 claims 只能使用 evidence 中的书内证据；claims 必须严格使用 [{"claim":"主张","evidence":["E1"]}] 结构，每个 claim 引用实际存在的 E 编号。',
      '2. expandedUnderstanding 可以解释、联系和推导，但必须明确它是理解扩展，不能声称是原书原话。',
      '3. 不得伪造书名、章节、页码、标准、论文、网址或引用。',
      '4. 外部资料没有可识别来源时，externalExtension 和 externalSources 必须留空。',
      '5. 证据不足时直接写入 limitations，不要用常识补齐书内结论。',
      '6. 不调用写文件、改代码、写笔记或其他有副作用的能力。',
      '7. 只返回一个严格 JSON 对象，不要 Markdown 代码围栏，不要 JSON 之外的说明。',
      '8. readingState.contextAttachments 中存在 book_selection 时，优先解释该原文；question 是用户可选的补充疑问，不能丢弃选区上下文。',
      '',
      JSON.stringify(payload),
    ].join('\n');
  }
}

module.exports = { ReaderContextAdapter, compactLocator };
