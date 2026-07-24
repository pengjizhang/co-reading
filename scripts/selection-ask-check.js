const path = require('path');
const { pathToFileURL } = require('url');
const { normalizeAssistantInput, DEFAULT_SELECTION_QUESTION } = require('../backend/ai/selection-request');
const { planQuery } = require('../backend/ai/contracts');
const { StructureAwareRetriever } = require('../backend/ai/retrieval');
const { ReaderContextAdapter } = require('../backend/ai/reader-context-adapter');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checks() {
  const frontend = await import(pathToFileURL(path.join(__dirname, '../client/src/lib/selectionAsk.js')).href);
  const sidebar = await import(pathToFileURL(path.join(__dirname, '../client/src/lib/sidebarResize.js')).href);
  const locator = {
    chapterId: 'c1',
    blockId: 'b2',
    sourceAnchor: 'otucn-route',
    sourceOrdinal: 1,
    quote: { exact: '超100G OTN采用基于OTUCn的n×100 Gbit/s演进路线。' },
  };
  const selection = {
    text: '超100G OTN采用基于OTUCn的n×100 Gbit/s演进路线。',
    bookId: 'otn',
    chapterTitle: 'OTN技术演进',
    locator,
  };
  const book = { id: 'otn', title: 'OTN原理与技术' };

  const defaultPayload = frontend.buildSelectionAskPayload({
    question: '',
    selection,
    book,
    mode: 'deep',
    useCurrentLocation: true,
    activeLocator: null,
    userId: 'reader-1',
  });
  assert(defaultPayload.question === frontend.DEFAULT_SELECTION_QUESTION, 'empty optional question should use the selection default');
  assert(defaultPayload.questionSource === 'selection_default', 'default selection question should be observable');
  assert(defaultPayload.contextAttachments[0].type === 'book_selection', 'selection should be an independent context attachment');
  assert(defaultPayload.activeLocator.blockId === 'b2', 'selection locator should take priority');

  const customPayload = frontend.buildSelectionAskPayload({
    question: '为什么选择OTUCn而不是OTU5？',
    selection,
    book,
    mode: 'quick',
    useCurrentLocation: true,
    activeLocator: null,
    userId: 'reader-1',
  });
  assert(customPayload.question === '为什么选择OTUCn而不是OTU5？' && customPayload.questionSource === 'user', 'custom optional question should be preserved');
  assert(frontend.selectionKey(selection) !== frontend.selectionKey({ ...selection, text: '另一段原文' }), 'replacing the selected text should produce a new attachment identity');

  const backendDefault = normalizeAssistantInput({
    question: '',
    contextAttachments: defaultPayload.contextAttachments,
  }, book.id);
  assert(backendDefault.question === DEFAULT_SELECTION_QUESTION, 'server should accept a selection without a supplemental question');
  assert(backendDefault.activeLocator.blockId === 'b2', 'server should preserve the attached locator');
  assert(normalizeAssistantInput({}, book.id).questionSource === 'empty', 'an empty request without a selection should remain invalid');

  const publication = {
    bookId: book.id,
    title: book.title,
    chapters: [{
      id: 'c1',
      title: 'OTN技术演进',
      blocks: [
        { id: 'b1', type: 'p', text: '本章介绍光传送网络的发展背景。', locator: { chapterId: 'c1', blockId: 'b1', sourceOrdinal: 0 } },
        { id: 'b2', type: 'p', text: selection.text, locator },
        { id: 'b3', type: 'p', text: '后续章节继续讨论接口与设备模型。', locator: { chapterId: 'c1', blockId: 'b3', sourceOrdinal: 2 } },
      ],
    }],
  };
  const plan = planQuery({
    question: backendDefault.question,
    questionSource: backendDefault.questionSource,
    mode: 'deep',
    bookIds: [book.id],
    activeLocator: locator,
    readingContext: {
      books: [book],
      toc: [],
      notes: [],
      activeLocator: locator,
      selectedText: backendDefault.selectedText,
      contextAttachments: backendDefault.contextAttachments,
    },
  });
  const retrieved = await new StructureAwareRetriever().retrieve(plan, [publication]);
  assert(retrieved[0]?.blockId === 'b2', 'the selected source block should be the first retrieved evidence');

  const adapted = new ReaderContextAdapter().build(plan, {
    evidence: retrieved,
    readingContext: plan.readingContext,
  });
  assert(adapted.payload.questionSource === 'selection_default', 'WorkAgent should know whether the question was generated or supplied');
  assert(adapted.payload.readingState.contextAttachments[0].type === 'book_selection', 'WorkAgent should receive the structured selection attachment');
  assert(adapted.payload.readingState.contextAttachments[0].locator.blockId === 'b2', 'WorkAgent should receive the source locator');
  assert(sidebar.sidebarWidthFromPointer(390, 500, 380, 1920) === 510, 'dragging the left border left should widen the sidebar');
  assert(sidebar.sidebarWidthFromPointer(390, 500, 650, 1920) === 300, 'dragging right should respect the desktop minimum');
  assert(sidebar.clampSidebarWidth(600, 780) === 600, 'browser zoom that creates an overlay viewport should still allow manual resizing');
  assert(sidebar.clampSidebarWidth(900, 1000) === 480, 'desktop resizing should preserve minimum reading space');

  return {
    optionalQuestion: true,
    customQuestion: true,
    attachmentReplacement: true,
    sourceBlockPriority: true,
    workagentContext: true,
    resizableSidebar: true,
    zoomResponsiveWidth: true,
  };
}

checks()
  .then((result) => console.log(JSON.stringify({ ok: true, checks: result }, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
