const base = process.env.COREADING_URL || 'http://localhost:3031';

async function json(url, options) {
  const response = await fetch(`${base}${url}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${result.error || ''}`);
  return result;
}

async function main() {
  const library = await json('/api/library?refresh=1');
  const book = library.books.find((item) => item.title.includes('OTN原理与技术'));
  if (!book) throw new Error('OTN fixture not found');
  const [publication, tocPayload] = await Promise.all([
    json(`/api/books/${book.id}/structured-text`),
    json(`/api/books/${book.id}/toc`)
  ]);
  const toc = tocPayload.toc || [];
  if (publication.version !== 5 || publication.parserVersion !== 'publication-v4') throw new Error('Publication cache version mismatch');
  if (toc.length !== 219) throw new Error(`Expected 219 NCX nodes, received ${toc.length}`);
  if (Math.max(...toc.map((item) => item.level)) !== 2) throw new Error('Expected a three-level directory');
  const blocks = new Set(publication.chapters.flatMap((chapter) => chapter.blocks.map((block) => `${chapter.id}:${block.id}`)));
  const invalid = toc.filter((item) => !item.locator || !blocks.has(`${item.locator.chapterId}:${item.locator.blockId}`));
  if (invalid.length) throw new Error(`${invalid.length} TOC nodes do not resolve to structured text`);
  const ids = new Set(toc.map((item) => item.id));
  const orphans = toc.filter((item) => item.parentId && !ids.has(item.parentId));
  if (orphans.length) throw new Error(`${orphans.length} TOC nodes have invalid parents`);
  for (const title of ['第1章 概述', '1.1.2 从PDH/SDH到WDM', '第9章 软件定义光网络']) {
    const item = toc.find((entry) => entry.title.replace(/\s+/g, ' ') === title);
    if (!item) throw new Error(`Missing TOC title: ${title}`);
    const resolved = await json(`/api/books/${book.id}/resolve-locator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator: item.locator }) });
    if (resolved.blockId !== item.locator.blockId || resolved.sourceAnchor !== item.locator.sourceAnchor) throw new Error(`Locator drift: ${title}`);
  }
  console.log(JSON.stringify({ ok: true, bookId: book.id, chapters: publication.chapters.length, tocNodes: toc.length, levels: 3, invalidTargets: invalid.length, samplesResolved: 3 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
