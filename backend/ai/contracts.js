const crypto = require('crypto');

const AI_SCHEMA_VERSION = 1;
const MODES = new Set(['quick', 'deep']);

function cleanText(value, max = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeContextAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((attachment) => ({
    type: cleanText(attachment?.type, 60),
    text: cleanText(attachment?.text, 2400),
    bookId: cleanText(attachment?.bookId, 160),
    bookTitle: cleanText(attachment?.bookTitle, 240),
    chapterTitle: cleanText(attachment?.chapterTitle, 300),
    locator: attachment?.locator || null,
  })).filter((attachment) => attachment.type && attachment.text);
}

function planQuery(input = {}) {
  const question = cleanText(input.question, 1200);
  if (!question) throw new Error('请输入要向本书提出的问题');
  const mode = MODES.has(input.mode) ? input.mode : 'quick';
  const intent = /比较|区别|异同|对比/.test(question) ? 'compare'
    : /总结|概括|主旨|核心/.test(question) ? 'summarize'
      : /哪里|哪一章|出处|原文/.test(question) ? 'locate'
        : /为什么|如何|原因|机制|原理/.test(question) ? 'explain'
          : 'answer';
  const contextAttachments = normalizeContextAttachments(input.readingContext?.contextAttachments);
  const selectedText = cleanText(
    input.readingContext?.selectedText
      || contextAttachments.find((attachment) => attachment.type === 'book_selection')?.text,
    2400
  );
  return {
    id: crypto.randomUUID(),
    schemaVersion: AI_SCHEMA_VERSION,
    question,
    questionSource: cleanText(input.questionSource, 40) || 'user',
    mode,
    intent,
    bookIds: [...new Set((input.bookIds || []).map(String).filter(Boolean))],
    activeLocator: input.activeLocator || null,
    useCurrentLocation: input.useCurrentLocation !== false,
    userId: cleanText(input.userId, 120) || 'local-user',
    signal: input.signal || null,
    readingContext: {
      books: Array.isArray(input.readingContext?.books) ? input.readingContext.books : [],
      toc: Array.isArray(input.readingContext?.toc) ? input.readingContext.toc : [],
      notes: Array.isArray(input.readingContext?.notes) ? input.readingContext.notes : [],
      activeLocator: input.readingContext?.activeLocator || input.activeLocator || null,
      selectedText,
      contextAttachments,
    },
    createdAt: new Date().toISOString(),
  };
}

function refusal(reason = 'insufficient_evidence') {
  return {
    answer: '仅根据本书现有内容，我还找不到足够证据回答这个问题。请换用书中的概念、人物或章节名称再问一次。',
    claims: [],
    citations: [],
    refused: true,
    refusalReason: reason,
  };
}

module.exports = { AI_SCHEMA_VERSION, cleanText, planQuery, refusal };
