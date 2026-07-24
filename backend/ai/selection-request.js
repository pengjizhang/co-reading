const DEFAULT_SELECTION_QUESTION = '请结合本书上下文，解释选中内容的含义、背景、关键概念，以及它与前后文的关系。';

function normalizeAssistantInput(body = {}, bookId = '') {
  const contextAttachments = (Array.isArray(body.contextAttachments) ? body.contextAttachments : [])
    .slice(0, 5)
    .map((attachment) => ({
      type: String(attachment?.type || '').slice(0, 60),
      text: String(attachment?.text || '').trim().slice(0, 2400),
      bookId: String(attachment?.bookId || bookId).slice(0, 160),
      bookTitle: String(attachment?.bookTitle || '').slice(0, 240),
      chapterTitle: String(attachment?.chapterTitle || '').slice(0, 300),
      locator: attachment?.locator || null,
    }))
    .filter((attachment) => attachment.type && attachment.text);
  const bookSelection = contextAttachments.find((attachment) => attachment.type === 'book_selection') || null;
  const selectedText = String(
    body.selectedText
      || bookSelection?.text
      || body.activeLocator?.quote?.exact
      || ''
  ).trim().slice(0, 2400);
  const suppliedQuestion = String(body.question || '').trim().slice(0, 1200);
  return {
    question: suppliedQuestion || (selectedText ? DEFAULT_SELECTION_QUESTION : ''),
    questionSource: suppliedQuestion ? 'user' : selectedText ? 'selection_default' : 'empty',
    selectedText,
    contextAttachments,
    activeLocator: bookSelection?.locator || body.activeLocator || null,
  };
}

module.exports = { DEFAULT_SELECTION_QUESTION, normalizeAssistantInput };
