const LOCATOR_VERSION = 2;
const PARSER_VERSION = 'publication-v4';

function blockQuote(block) {
  return String(block?.text || block?.caption || block?.alt || '').replace(/\s+/g, ' ').trim();
}

function createLocator(block, chapter) {
  const blocks = chapter?.blocks || [];
  const index = Math.max(0, blocks.findIndex((item) => item.id === block?.id));
  const exact = blockQuote(block).slice(0, 500);
  return {
    version: LOCATOR_VERSION,
    parserVersion: PARSER_VERSION,
    chapterId: chapter?.id || null,
    href: chapter?.href || null,
    blockId: block?.id || null,
    sourceAnchor: block?.sourceAnchor || null,
    sourceOrdinal: block?.sourceOrdinal ?? index,
    progression: blocks.length > 1 ? index / (blocks.length - 1) : 0,
    page: block?.page || chapter?.page || null,
    assetId: block?.assetId || null,
    textQuote: exact.slice(0, 180),
    quote: {
      exact,
      prefix: exact.slice(0, 48),
      suffix: exact.slice(-48)
    }
  };
}

function resolveLocator(publication, locator = {}) {
  const chapters = publication?.chapters || [];
  let chapter = chapters.find((item) => item.id === locator.chapterId || (locator.href && item.href === locator.href));
  const exact = String(locator.quote?.exact || locator.textQuote || '').replace(/\s+/g, ' ').trim();
  const candidates = chapter ? [chapter] : chapters;

  for (const candidate of candidates) {
    const byId = candidate.blocks?.find((block) => block.id === locator.blockId || (locator.sourceAnchor && block.sourceAnchor === locator.sourceAnchor));
    if (byId) return createLocator(byId, candidate);
  }
  if (exact) {
    const needle = exact.slice(0, 180);
    for (const candidate of candidates) {
      const matched = candidate.blocks?.find((block) => blockQuote(block).includes(needle) || needle.includes(blockQuote(block).slice(0, 120)));
      if (matched) return createLocator(matched, candidate);
    }
  }
  if (!chapter && locator.page) chapter = chapters.find((item) => item.page === locator.page);
  chapter ||= chapters[0];
  if (!chapter?.blocks?.length) return null;
  const progression = Math.max(0, Math.min(1, Number(locator.progression) || 0));
  const index = Math.min(chapter.blocks.length - 1, Math.round(progression * (chapter.blocks.length - 1)));
  return createLocator(chapter.blocks[index], chapter);
}

module.exports = { LOCATOR_VERSION, PARSER_VERSION, createLocator, resolveLocator };
