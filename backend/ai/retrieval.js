const { cleanText } = require('./contracts');

const STOP_WORDS = new Set(['什么', '怎么', '如何', '为什么', '是否', '哪些', '这个', '那个', '作者', '本书', '认为', '介绍', '说明', '可以', '进行', '以及', '一个', '一种']);

function queryTerms(question) {
  const normalized = cleanText(question).toLocaleLowerCase();
  const terms = new Set((normalized.match(/[\p{L}\p{N}]{2,}/gu) || []).filter((term) => !STOP_WORDS.has(term)));
  for (const token of [...terms]) {
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 2) {
      for (let size = 2; size <= Math.min(5, token.length); size += 1) {
        for (let index = 0; index <= token.length - size; index += 1) terms.add(token.slice(index, index + size));
      }
    }
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 48);
}

function occurrenceScore(text, term) {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(term, cursor)) >= 0 && count < 4) { count += 1; cursor += term.length; }
  return count * Math.min(6, Math.max(1.5, term.length));
}

function blockText(block) {
  if (block.text) return cleanText(block.text, 5000);
  if (block.type === 'image') return cleanText([block.alt, block.caption].filter(Boolean).join('：'), 1000);
  return '';
}

class StructureAwareRetriever {
  constructor(options = {}) {
    this.options = { quickLimit: 6, deepLimit: 12, ...options };
    this.id = 'structure-lexical-v1';
  }

  async retrieve(plan, publications) {
    const selectedText = cleanText(plan.readingContext?.selectedText, 2400);
    const selectedTextLower = selectedText.toLocaleLowerCase();
    const terms = queryTerms(`${plan.question}\n${selectedText}`);
    const candidates = [];
    for (const publication of publications) {
      for (const [chapterIndex, chapter] of (publication.chapters || []).entries()) {
        for (const [blockIndex, block] of (chapter.blocks || []).entries()) {
          const body = blockText(block);
          if (!body) continue;
          const lower = body.toLocaleLowerCase();
          const title = cleanText(chapter.title).toLocaleLowerCase();
          let score = terms.reduce((sum, term) => sum + occurrenceScore(lower, term) + occurrenceScore(title, term) * 1.35, 0);
          if (lower.includes(plan.question.toLocaleLowerCase())) score += 24;
          if (selectedTextLower && lower.includes(selectedTextLower)) score += 40;
          if (selectedText && plan.activeLocator?.blockId === block.id) score += 28;
          if (block.type === 'heading') score *= 1.12;
          if (block.type === 'image' && score) score += 1.5;
          if (plan.useCurrentLocation && plan.activeLocator?.chapterId === chapter.id) score += score ? 4 : 0.25;
          if (!score) continue;
          candidates.push({ score, publication, chapter, chapterIndex, block, blockIndex, body });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.chapterIndex - b.chapterIndex || a.blockIndex - b.blockIndex);
    const limit = plan.mode === 'deep' ? this.options.deepLimit : this.options.quickLimit;
    const selected = [];
    const perChapter = new Map();
    const seen = new Set();
    for (const candidate of candidates) {
      const key = `${candidate.publication.bookId}:${candidate.chapter.id}:${candidate.block.id}`;
      if (seen.has(key)) continue;
      const chapterKey = `${candidate.publication.bookId}:${candidate.chapter.id}`;
      if ((perChapter.get(chapterKey) || 0) >= (plan.mode === 'deep' ? 4 : 2)) continue;
      seen.add(key);
      perChapter.set(chapterKey, (perChapter.get(chapterKey) || 0) + 1);
      selected.push(candidate);
      if (selected.length >= limit) break;
    }
    return selected.map((item, index) => {
      const neighbors = item.chapter.blocks.slice(Math.max(0, item.blockIndex - 1), item.blockIndex + 2)
        .map(blockText).filter(Boolean);
      const context = cleanText(neighbors.join('\n'), plan.mode === 'deep' ? 1800 : 900);
      return {
        id: `E${index + 1}`,
        bookId: item.publication.bookId,
        bookTitle: item.publication.title || item.publication.bookTitle || '',
        chapterId: item.chapter.id,
        chapterTitle: item.chapter.title || '未命名章节',
        blockId: item.block.id,
        kind: item.block.type === 'image' ? 'image' : 'text',
        excerpt: item.body.slice(0, 420),
        context,
        score: Number(item.score.toFixed(2)),
        locator: item.block.locator || null,
      };
    });
  }
}

module.exports = { StructureAwareRetriever, queryTerms };
