const path = require('path');
const Database = require('better-sqlite3');

const base = process.env.COREADING_URL || 'http://localhost:3030';

async function json(url, options) {
  const response = await fetch(`${base}${url}`, options);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function main() {
  const health = await json('/api/health');
  if (health.storage !== 'sqlite-wal' || health.locatorVersion !== 2) throw new Error('Storage or locator health mismatch');
  const library = await json('/api/library');
  const formats = ['EPUB', 'PDF', 'DOCX'];
  const checked = {};
  for (const format of formats) {
    const book = library.books.find((item) => item.format === format && item.size > 0);
    if (!book) throw new Error(`No ${format} fixture found`);
    const publication = await json(`/api/books/${book.id}/structured-text`);
    if (publication.version !== 5 || publication.parserVersion !== 'publication-v4' || !publication.chapters?.length) throw new Error(`${format} publication schema mismatch`);
    checked[format] = { id: book.id, chapters: publication.chapters.length, blocks: publication.totalBlocks };
    const chapter = publication.chapters.find((item) => item.blocks?.length);
    const block = chapter?.blocks?.[0];
    if (block) {
      const resolved = await json(`/api/books/${book.id}/resolve-locator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator: { chapterId: chapter.id, blockId: 'legacy-missing', textQuote: block.text || block.caption || '' } }) });
      if (resolved.version !== 2 || !resolved.blockId) throw new Error(`${format} locator recovery failed`);
    }
    if (format === 'EPUB') {
      const response = await fetch(`${base}/api/books/${book.id}/epub-files/${publication.chapters[0].href}`);
      if (!response.ok || !response.headers.get('content-security-policy') || !response.headers.get('content-type')?.startsWith('text/html')) throw new Error('EPUB safe rendering failed');
    }
  }
  const database = new Database(path.join(__dirname, '..', 'co-reading.sqlite3'), { readonly: true });
  const sqlite = { journal: database.pragma('journal_mode', { simple: true }), segments: database.prepare('SELECT count(*) AS count FROM state_segments').get().count, ftsRows: database.prepare('SELECT count(*) AS count FROM publication_fts').get().count };
  database.close();
  if (sqlite.journal !== 'wal' || sqlite.segments < 10 || sqlite.ftsRows < 1) throw new Error('SQLite regression failed');
  console.log(JSON.stringify({ ok: true, health, checked, sqlite }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
