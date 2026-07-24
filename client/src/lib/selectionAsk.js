export const DEFAULT_SELECTION_QUESTION = '请结合本书上下文，解释选中内容的含义、背景、关键概念，以及它与前后文的关系。';

export const SELECTION_QUICK_QUESTIONS = [
  '解释这段内容',
  '用一个例子说明',
  '联系前后文分析',
  '分析这里的原因',
  '这段内容有什么局限',
];

export function selectionKey(selection) {
  if (!selection?.text) return '';
  const locator = selection.locator || {};
  return [
    selection.bookId || '',
    locator.chapterId || '',
    locator.blockId || '',
    locator.sourceAnchor || '',
    selection.text,
  ].join('|');
}

export function buildBookSelectionAttachment(selection, book) {
  const text = String(selection?.text || '').trim();
  if (!text) return null;
  return {
    type: 'book_selection',
    text: text.slice(0, 2400),
    bookId: String(selection.bookId || book?.id || ''),
    bookTitle: String(book?.title || '').slice(0, 240),
    chapterTitle: String(selection.chapterTitle || '').slice(0, 300),
    locator: selection.locator || null,
  };
}

export function resolveSelectionQuestion(question, selection) {
  const customQuestion = String(question || '').trim();
  if (customQuestion) return { question: customQuestion, questionSource: 'user' };
  if (selection?.text) return { question: DEFAULT_SELECTION_QUESTION, questionSource: 'selection_default' };
  return { question: '', questionSource: 'empty' };
}

export function buildSelectionAskPayload({
  question,
  selection,
  book,
  mode,
  useCurrentLocation,
  activeLocator,
  userId,
}) {
  const resolved = resolveSelectionQuestion(question, selection);
  const attachment = buildBookSelectionAttachment(selection, book);
  return {
    question: resolved.question,
    questionSource: resolved.questionSource,
    mode,
    useCurrentLocation,
    activeLocator: attachment?.locator || activeLocator || null,
    selectedText: attachment?.text || '',
    contextAttachments: attachment ? [attachment] : [],
    userId,
  };
}
