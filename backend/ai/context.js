const { cleanText } = require('./contracts');

class ContextCompiler {
  constructor(options = {}) {
    this.options = { quickChars: 9000, deepChars: 24000, ...options };
    this.id = 'grounded-context-v1';
  }

  compile(plan, evidence) {
    const budget = plan.mode === 'deep' ? this.options.deepChars : this.options.quickChars;
    const selected = [];
    let used = 0;
    for (const item of evidence) {
      const rendered = `[${item.id}]《${item.bookTitle}》/ ${item.chapterTitle}\n${cleanText(item.context, 2400)}`;
      if (selected.length && used + rendered.length > budget) continue;
      selected.push({ ...item, rendered });
      used += rendered.length;
    }
    return {
      schemaVersion: 1,
      queryId: plan.id,
      question: plan.question,
      intent: plan.intent,
      mode: plan.mode,
      evidence: selected,
      rendered: selected.map((item) => item.rendered).join('\n\n'),
      readingContext: plan.readingContext || {},
      budget: { maximumCharacters: budget, usedCharacters: used },
    };
  }
}

module.exports = { ContextCompiler };
