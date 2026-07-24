const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const base = process.env.COREADING_URL || 'http://localhost:3031';
const project = path.resolve(__dirname, '..');
const root = path.resolve(project, '..');
const importDir = path.join(root, '同读书库');

function fixture() {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'));
  zip.addFile('OEBPS/content.opf', Buffer.from('<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">迭代七验收书</dc:title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'));
  zip.addFile('OEBPS/chapter.xhtml', Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>验收章节</h1><p>用于验证书籍生命周期。</p></body></html>'));
  return zip.toBuffer();
}

async function request(url, options = {}, expected = 200) {
  const response = await fetch(`${base}${url}`, options);
  const result = await response.json();
  if (response.status !== expected) throw new Error(`${url}: expected ${expected}, got ${response.status}: ${result.error || ''}`);
  return result;
}

async function lifecycle(id, action) {
  return request(`/api/books/${id}/lifecycle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
}

async function status(id) {
  const library = await request('/api/library?refresh=1');
  return library.books.find((book) => book.id === id);
}

async function main() {
  const token = crypto.randomUUID().slice(0, 8);
  const fileName = `iteration-7-${token}.epub`;
  const buffer = fixture();
  let imported;
  try {
    imported = await request(`/api/library/import?name=${encodeURIComponent(fileName)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer }, 201);
    if (!imported.id || imported.libraryStatus !== 'active') throw new Error('import did not create an active publication');
    await request(`/api/library/import?name=${encodeURIComponent(`duplicate-${fileName}`)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer }, 409);
    await request(`/api/library/import?name=invalid-${token}.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not a pdf') }, 422);

    await request(`/api/books/${imported.id}/metadata`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '迭代七验收书（已编辑）', author: 'Co-reading QA', category: '验收' }) });
    let book = await status(imported.id);
    if (book.title !== '迭代七验收书（已编辑）' || book.author !== 'Co-reading QA') throw new Error('metadata update failed');

    await lifecycle(imported.id, 'archive');
    book = await status(imported.id);
    if (book.libraryStatus !== 'archived' || !book.canOpen) throw new Error('archive failed');

    await lifecycle(imported.id, 'remove');
    book = await status(imported.id);
    if (book.libraryStatus !== 'removed' || book.canOpen) throw new Error('remove failed');

    await lifecycle(imported.id, 'restore-library');
    await lifecycle(imported.id, 'trash');
    book = await status(imported.id);
    if (book.libraryStatus !== 'trashed' || book.canOpen) throw new Error('recoverable delete failed');

    await lifecycle(imported.id, 'restore-file');
    book = await status(imported.id);
    if (book.libraryStatus !== 'active' || !book.canOpen) throw new Error('file restore failed');

    console.log(JSON.stringify({ ok: true, verified: ['validated import', 'content deduplication', 'metadata', 'archive', 'remove and restore', 'recoverable file delete and restore'], id: imported.id }, null, 2));
  } finally {
    if (imported?.id) {
      const database = new Database(path.join(project, 'co-reading.sqlite3'));
      const record = database.prepare('SELECT relative_path, original_relative_path FROM publications WHERE id=?').get(imported.id);
      for (const relative of [record?.relative_path, record?.original_relative_path]) {
        if (!relative) continue;
        const target = path.resolve(root, relative);
        if (target.startsWith(importDir + path.sep) && fs.existsSync(target)) fs.unlinkSync(target);
      }
      database.transaction(() => {
        database.prepare('DELETE FROM publication_fts WHERE book_id=?').run(imported.id);
        database.prepare('DELETE FROM publication_index_state WHERE book_id=?').run(imported.id);
        database.prepare('DELETE FROM publications WHERE id=?').run(imported.id);
      })();
      database.close();
      await request('/api/library?refresh=1');
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
