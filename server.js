const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const AdmZip = require('adm-zip');
const { SQLiteStorage } = require('./backend/storage');
const { createLocator, resolveLocator } = require('./backend/locator');
const { BookAIService } = require('./backend/ai/service');
const { normalizeAssistantInput } = require('./backend/ai/selection-request');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = Number(process.env.PORT || 3030);
const APP_VERSION = 12;
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(__dirname, 'db.json');
const SQLITE_FILE = path.join(__dirname, 'co-reading.sqlite3');
const CACHE_DIR = path.join(__dirname, '.cache');
const ASSET_DIR = path.join(CACHE_DIR, 'assets');
const IMPORT_DIR = path.join(ROOT, '同读书库');
const TRASH_DIR = path.join(ROOT, '.co-reading-trash');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'client', 'dist')));

const emptyDB = () => ({
  version: 3,
  profiles: {},
  notes: {},
  progress: {},
  chat: {},
  drawings: {},
  rooms: {},
  discussions: {},
  boards: {},
  reviewState: {},
  readingEvents: []
});

function migrateDB(raw = {}) {
  const next = { ...emptyDB(), ...raw, version: 3 };
  for (const key of ['profiles', 'notes', 'progress', 'chat', 'drawings', 'rooms', 'discussions', 'boards', 'reviewState']) {
    if (!next[key] || typeof next[key] !== 'object') next[key] = {};
  }
  if (!Array.isArray(next.readingEvents)) next.readingEvents = [];
  return next;
}

const storage = new SQLiteStorage(SQLITE_FILE, DB_FILE);
const bookAI = new BookAIService({ recordRun: (run) => storage.recordAIRun(run) });
let db = migrateDB(storage.load(emptyDB()));
let persistChain = Promise.resolve();

function persistDB() {
  const snapshot = JSON.stringify(db, null, 2);
  const temp = `${DB_FILE}.tmp`;
  storage.save(db);
  persistChain = persistChain.then(async () => {
    await fsp.writeFile(temp, snapshot, 'utf8');
    await fsp.rename(temp, DB_FILE);
  }).catch((error) => console.error('Database persistence failed:', error));
  return persistChain;
}

function mutate(mutator) {
  const result = mutator(db);
  persistDB();
  return result;
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(IMPORT_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

const decodeEntities = (text) => text
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const stripText = (html) => decodeEntities(html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

let catalogCache = { at: 0, books: [] };
function scanBooks(force = false, includeInactive = false) {
  if (!force && Date.now() - catalogCache.at < 5000) return includeInactive ? catalogCache.books : catalogCache.books.filter((book) => book.libraryStatus === 'active' && !book.missing);
  const books = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'co-reading' || entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.epub', '.pdf', '.docx'].includes(ext)) continue;
      try {
        const stat = fs.statSync(full);
        const relativePath = path.relative(ROOT, full).replace(/\\/g, '/');
        const name = path.basename(entry.name, ext);
        const cleanTitle = name.replace(/\s*\((z-library|z-lib|1lib)[\s\S]*$/i, '').replace(/\s*\[.*?\]\s*$/g, '').trim() || name;
        books.push({
          id: crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 24),
          name,
          title: cleanTitle,
          fileName: entry.name,
          relativePath,
          format: ext.slice(1).toUpperCase(),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          category: path.dirname(relativePath) === '.' ? '未分类' : relativePath.split('/')[0],
          managed: relativePath.startsWith('同读书库/')
        });
      } catch {}
    }
  };
  walk(ROOT);
  storage.syncCatalog(books);
  const records = storage.listPublications();
  const recordById = new Map(records.map((record) => [record.id, record]));
  const presentIds = new Set(books.map((book) => book.id));
  const hydrated = books.map((book) => {
    const record = recordById.get(book.id);
    return { ...book, title: record?.title_override || book.title, author: record?.author_override || '', category: record?.category_override || book.category, libraryStatus: record?.status || 'active', contentHash: record?.content_hash || null };
  });
  for (const record of records) if (!presentIds.has(record.id)) hydrated.push({
    id: record.id, name: path.basename(record.file_name, path.extname(record.file_name)), title: record.title_override || path.basename(record.file_name, path.extname(record.file_name)), author: record.author_override || '', fileName: record.file_name, relativePath: record.relative_path, format: record.format, size: record.size, modifiedAt: record.modified_at, category: record.category_override || path.dirname(record.relative_path).split('/')[0] || '未分类', managed: Boolean(record.managed), libraryStatus: record.status, contentHash: record.content_hash, missing: record.status === 'missing' || record.status === 'trashed'
  });
  catalogCache = { at: Date.now(), books: hydrated };
  return includeInactive ? hydrated : hydrated.filter((book) => book.libraryStatus === 'active' && !book.missing);
}

function getBook(id) { return scanBooks(false, true).find((book) => book.id === id && !book.missing && book.libraryStatus !== 'trashed'); }
function absoluteBookPath(book) {
  const candidate = path.resolve(ROOT, book.relativePath);
  if (!candidate.startsWith(ROOT + path.sep)) throw new Error('Invalid book path');
  return candidate;
}

function safeFileName(value) {
  const base = path.basename(String(value || 'book')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  return base || `book-${Date.now()}`;
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function validateImportedBook(fileName, buffer) {
  const ext = path.extname(fileName).toLowerCase();
  if (!['.epub', '.pdf', '.docx'].includes(ext)) throw new Error('仅支持 EPUB、PDF、DOCX');
  if (!buffer?.length) throw new Error('文件为空');
  if (ext === '.pdf' && buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF 文件头无效');
  if (ext !== '.pdf') {
    let zip;
    try { zip = new AdmZip(buffer); } catch { throw new Error('压缩容器损坏'); }
    if (ext === '.docx' && !zip.getEntry('word/document.xml')) throw new Error('DOCX 主文档缺失');
    if (ext === '.epub' && !zip.getEntry('META-INF/container.xml')) throw new Error('EPUB container.xml 缺失');
  }
  return ext;
}

function publicationHref(base, rawHref = '') {
  const [rawPath, fragment = ''] = String(rawHref).split('#', 2);
  let decodedPath = rawPath;
  let decodedFragment = fragment;
  try { decodedPath = decodeURIComponent(rawPath); } catch {}
  try { decodedFragment = decodeURIComponent(fragment); } catch {}
  return { href: path.posix.normalize(path.posix.join(base, decodedPath)), fragment: decodedFragment };
}

function normalizeTocNodes(nodes) {
  const parents = [];
  return nodes.map((node, index) => {
    const level = Math.max(0, Math.min(8, Number(node.level) || 0));
    const id = `toc-${index + 1}`;
    const parentId = level > 0 ? parents[level - 1] || null : null;
    parents[level] = id;
    parents.length = level + 1;
    return { ...node, id, level, parentId };
  });
}

function parseNcxNavigation(markup, ncxPath) {
  const nodes = [];
  const stack = [];
  let order = 0;
  const tokens = markup.match(/<navPoint\b[^>]*>|<\/navPoint\s*>|<text\b[^>]*>[\s\S]*?<\/text\s*>|<content\b[^>]*\/?\s*>/gi) || [];
  for (const token of tokens) {
    if (/^<navPoint\b/i.test(token)) stack.push({ level: stack.length, order: order++, title: '', source: '' });
    else if (/^<\/navPoint/i.test(token)) {
      const node = stack.pop();
      if (node?.title && node.source) nodes.push(node);
    } else if (/^<text\b/i.test(token) && stack.length && !stack.at(-1).title) stack.at(-1).title = stripText(token);
    else if (/^<content\b/i.test(token) && stack.length) stack.at(-1).source = htmlAttr(token, 'src');
  }
  return normalizeTocNodes(nodes.sort((a, b) => a.order - b.order).map((node) => ({ ...publicationHref(path.posix.dirname(ncxPath), node.source), title: node.title, level: node.level })));
}

function parseNavDocument(markup, navPath) {
  const nav = [...markup.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)].find((match) => /(?:epub:type|type)\s*=\s*["'][^"']*toc/i.test(match[1])) || null;
  if (!nav) return [];
  const nodes = [];
  let listDepth = 0;
  for (const token of nav[2].match(/<ol\b[^>]*>|<\/ol\s*>|<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || []) {
    if (/^<ol\b/i.test(token)) listDepth += 1;
    else if (/^<\/ol/i.test(token)) listDepth = Math.max(0, listDepth - 1);
    else {
      const source = htmlAttr(token, 'href');
      const title = stripText(token);
      if (source && title) nodes.push({ ...publicationHref(path.posix.dirname(navPath), source), title, level: Math.max(0, listDepth - 1) });
    }
  }
  return normalizeTocNodes(nodes);
}

function findEpubPackage(zip) {
  try {
    const container = zip.readAsText('META-INF/container.xml');
    const opfPath = container.match(/full-path=["']([^"']+)["']/i)?.[1];
    if (!opfPath) return { spine: [], toc: [] };
    const opf = zip.readAsText(opfPath);
    const base = path.posix.dirname(opfPath);
    const manifest = {};
    for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = htmlAttr(match[0], 'id'); const href = htmlAttr(match[0], 'href');
      if (id && href) manifest[id] = { ...publicationHref(base, href), mediaType: htmlAttr(match[0], 'media-type'), properties: htmlAttr(match[0], 'properties') };
    }
    const spineTag = opf.match(/<spine\b[^>]*>/i)?.[0] || '';
    const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map((match) => manifest[htmlAttr(match[0], 'idref')]?.href).filter(Boolean);
    const navItem = Object.values(manifest).find((item) => item.properties.split(/\s+/).includes('nav'));
    const ncxItem = manifest[htmlAttr(spineTag, 'toc')] || Object.values(manifest).find((item) => item.mediaType === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.href));
    let toc = [];
    if (navItem && zip.getEntry(navItem.href)) toc = parseNavDocument(zip.readAsText(navItem.href), navItem.href);
    if (!toc.length && ncxItem && zip.getEntry(ncxItem.href)) toc = parseNcxNavigation(zip.readAsText(ncxItem.href), ncxItem.href);
    return { spine, toc, opfPath };
  } catch { return { spine: [], toc: [] }; }
}

function htmlAttr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i')) || tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return decodeEntities(match?.[2] || match?.[1] || '').trim();
}

function imageExtension(mime = '') {
  const normalized = mime.toLowerCase().split(';')[0];
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' })[normalized] || 'bin';
}

function imageMime(fileName = '') {
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif' })[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function publicationMime(fileName = '') {
  return ({ '.xhtml': 'text/html', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4' })[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function sanitizePublicationMarkup(markup) {
  return markup
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '');
}

async function persistDataImage(bookId, source, prefix = 'd') {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(source || '');
  if (!match) return null;
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 40 * 1024 * 1024) return null;
  const extension = imageExtension(match[1]);
  if (extension === 'bin') return null;
  const assetId = `${prefix}-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)}.${extension}`;
  const directory = path.join(ASSET_DIR, bookId);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, assetId), data);
  return assetId;
}

async function blocksFromHtml(html, chapterPrefix, resolveImage) {
  const blocks = [];
  let index = 0;
  const regex = /<(h[1-6]|p|li|blockquote|pre)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(regex)) {
    const text = stripText(match[3]);
    const heading = /^h([1-6])$/i.exec(match[1]);
    const sourceClass = htmlAttr(match[0], 'class');
    const sourceAnchor = htmlAttr(match[0], 'id');
    const semanticLevel = /(?:^|\s)chapterTitle(?:\s|$)/i.test(sourceClass) ? 1
      : /(?:^|\s)sectionTitle(?:\s|$)/i.test(sourceClass) ? 2
        : /(?:^|\s)(?:listTitle\d*|subsectionTitle)(?:\s|$)/i.test(sourceClass) ? 3 : null;
    const level = heading ? Number(heading[1]) : semanticLevel;
    if (text.length >= 2) {
      index += 1;
      blocks.push({ id: `${chapterPrefix}-b${index}`, text, type: level ? 'heading' : match[1].toLowerCase(), level, sourceAnchor: sourceAnchor || null, sourceClass: sourceClass || null, sourceOrdinal: index - 1 });
    }
    for (const imageTag of match[3].matchAll(/<(?:img|image)\b[^>]*>/gi)) {
      const source = htmlAttr(imageTag[0], 'src') || htmlAttr(imageTag[0], 'href') || htmlAttr(imageTag[0], 'xlink:href');
      const assetId = source && resolveImage ? await resolveImage(source) : null;
      if (!assetId) continue;
      index += 1;
      const alt = htmlAttr(imageTag[0], 'alt') || `原书插图 ${index}`;
      blocks.push({ id: `${chapterPrefix}-b${index}`, type: 'image', assetId, alt, caption: alt, sourceAnchor: htmlAttr(imageTag[0], 'id') || null, width: Number(htmlAttr(imageTag[0], 'width')) || null, height: Number(htmlAttr(imageTag[0], 'height')) || null, sourceOrdinal: index - 1 });
    }
  }
  // Some EPUB/DOCX exporters place images outside paragraph-like containers.
  const captured = new Set(blocks.filter((block) => block.type === 'image').map((block) => block.assetId));
  for (const imageTag of html.matchAll(/<(?:img|image)\b[^>]*>/gi)) {
    const source = htmlAttr(imageTag[0], 'src') || htmlAttr(imageTag[0], 'href') || htmlAttr(imageTag[0], 'xlink:href');
    const assetId = source && resolveImage ? await resolveImage(source) : null;
    if (!assetId || captured.has(assetId)) continue;
    captured.add(assetId); index += 1;
    const alt = htmlAttr(imageTag[0], 'alt') || `原书插图 ${index}`;
    blocks.push({ id: `${chapterPrefix}-b${index}`, type: 'image', assetId, alt, caption: alt, width: Number(htmlAttr(imageTag[0], 'width')) || null, height: Number(htmlAttr(imageTag[0], 'height')) || null, sourceOrdinal: index - 1 });
  }
  return blocks;
}

function buildPublicationToc(rawToc, chapters) {
  const byHref = new Map(chapters.map((chapter) => [chapter.href, chapter]));
  return rawToc.map((item) => {
    const chapter = byHref.get(item.href);
    if (!chapter?.blocks?.length) return { ...item, locator: null };
    const normalizedTitle = item.title.replace(/\s+/g, ' ').trim();
    const block = (item.fragment && chapter.blocks.find((candidate) => candidate.sourceAnchor === item.fragment))
      || chapter.blocks.find((candidate) => String(candidate.text || '').replace(/\s+/g, ' ').trim() === normalizedTitle)
      || chapter.blocks[0];
    return { ...item, locator: { ...createLocator(block, chapter), sourceAnchor: item.fragment || block.sourceAnchor || null } };
  });
}

async function extractBook(book) {
  const file = absoluteBookPath(book);
  const fingerprint = crypto.createHash('sha1').update(`publication-v4|${book.relativePath}|${book.size}|${book.modifiedAt}`).digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${book.id}.v5.json`);
  try {
    const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    if (cached.fingerprint === fingerprint) { storage.indexPublication(cached); return cached; }
  } catch {}

  const chapters = [];
  let publicationToc = [];
  if (book.format === 'EPUB') {
    const zip = new AdmZip(file);
    const epubPackage = findEpubPackage(zip);
    let spine = epubPackage.spine;
    if (!spine.length) spine = zip.getEntries().map((e) => e.entryName).filter((n) => /\.(x?html?|htm)$/i.test(n));
    let chapterIndex = 0;
    for (const entryName of spine) {
      const entry = zip.getEntry(entryName);
      if (!entry) continue;
      const html = entry.getData().toString('utf8');
      const blocks = await blocksFromHtml(html, `c${chapterIndex + 1}`, async (source) => {
        if (/^data:image\//i.test(source)) return persistDataImage(book.id, source, 'e');
        let cleanSource;
        try { cleanSource = decodeURIComponent(source.split('#')[0].split('?')[0]); } catch { cleanSource = source.split('#')[0].split('?')[0]; }
        const resourcePath = path.posix.normalize(path.posix.join(path.posix.dirname(entryName), cleanSource));
        if (resourcePath.startsWith('../') || !zip.getEntry(resourcePath) || !/^image\//.test(imageMime(resourcePath))) return null;
        return `ez-${Buffer.from(resourcePath).toString('base64url')}`;
      });
      if (!blocks.length) continue;
      chapterIndex += 1;
      const heading = blocks.find((b) => b.type === 'heading');
      const navigationTitle = epubPackage.toc.find((item) => item.href === entryName && (!item.fragment || item.fragment === blocks[0]?.sourceAnchor))?.title;
      const documentTitle = stripText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
      chapters.push({ id: `c${chapterIndex}`, href: entryName, title: navigationTitle || heading?.text || documentTitle || `第 ${chapterIndex} 节`, blocks });
    }
    publicationToc = buildPublicationToc(epubPackage.toc, chapters);
  } else if (book.format === 'DOCX') {
    const result = await mammoth.convertToHtml({ path: file });
    const blocks = await blocksFromHtml(result.value, 'c1', (source) => persistDataImage(book.id, source, 'd'));
    chapters.push({ id: 'c1', href: 'word/document.xml', title: blocks.find((b) => b.type === 'heading')?.text || book.title, blocks });
  } else if (book.format === 'PDF') {
    const parser = new PDFParse({ data: await fsp.readFile(file) });
    const result = await parser.getText();
    const pageTexts = String(result.text || '').replace(/-- \d+ of \d+ --/g, '\f').split('\f');
    let blockIndex = 0;
    for (let page = 0; page < pageTexts.length; page += 1) {
      const blocks = pageTexts[page].split(/\n\s*\n+/).map((raw) => raw.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 3).map((text, sourceOrdinal) => ({ id: `p${page + 1}-b${++blockIndex}`, text, type: 'p', page: page + 1, level: null, sourceOrdinal }));
      if (blocks.length) chapters.push({ id: `p${page + 1}`, href: `page:${page + 1}`, title: `第 ${page + 1} 页`, page: page + 1, blocks });
    }
    if (!chapters.length) chapters.push({ id: 'scan', href: 'page:1', title: '扫描版 PDF', blocks: [], isImageScan: true });
    await parser.destroy();
  }

  if (!publicationToc.length) publicationToc = chapters.map((chapter, index) => ({ id: `toc-${index + 1}`, parentId: null, title: chapter.title, level: 0, href: chapter.href, fragment: '', locator: chapter.blocks[0] ? createLocator(chapter.blocks[0], chapter) : null }));
  const payload = { version: 5, parserVersion: 'publication-v4', fingerprint, bookId: book.id, chapters, toc: publicationToc, totalBlocks: chapters.reduce((n, c) => n + c.blocks.length, 0), totalImages: chapters.reduce((n, c) => n + c.blocks.filter((block) => block.type === 'image').length, 0) };
  await fsp.writeFile(cacheFile, JSON.stringify(payload), 'utf8');
  storage.indexPublication(payload);
  return payload;
}

function locatorFor(block, chapter) {
  return createLocator(block, chapter);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, storage: 'sqlite-wal', locatorVersion: 2, tocVersion: 2, libraryLifecycle: 'recoverable', bookAI: bookAI.capabilities() }));
app.get('/api/ai/capabilities', async (req, res) => {
  try {
    res.json(req.query.probe === '1' ? await bookAI.probeCapabilities() : bookAI.capabilities());
  } catch (error) {
    res.status(503).json({ error: error.message, ...bookAI.capabilities() });
  }
});

app.get('/api/library', (req, res) => {
  const userId = req.query.userId || 'local-user';
  const books = scanBooks(req.query.refresh === '1', true).map((book) => {
    const progress = db.progress[book.id]?.[userId] || null;
    const notes = (db.notes[book.id] || []).filter((note) => note.userId === userId || note.visibility === 'room');
    return { ...book, progress, noteCount: notes.length, status: progress?.percentage >= 100 ? 'finished' : progress?.percentage > 0 ? 'reading' : 'unread', canOpen: !book.missing && !['removed', 'trashed'].includes(book.libraryStatus) };
  });
  const active = books.filter((book) => book.libraryStatus === 'active');
  res.json({ books, totals: { books: active.length, reading: active.filter((b) => b.status === 'reading').length, notes: active.reduce((n, b) => n + b.noteCount, 0), rooms: Object.keys(db.rooms).length, archived: books.filter((b) => b.libraryStatus === 'archived').length, removed: books.filter((b) => b.libraryStatus === 'removed').length, missing: books.filter((b) => b.libraryStatus === 'missing').length } });
});

app.post('/api/library/import', express.raw({ type: 'application/octet-stream', limit: '250mb' }), async (req, res) => {
  const fileName = safeFileName(req.query.name);
  const strategy = ['skip', 'keep'].includes(req.query.strategy) ? req.query.strategy : 'skip';
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
  try {
    validateImportedBook(fileName, buffer);
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    let duplicate = storage.findPublicationByHash(contentHash);
    if (!duplicate) {
      for (const book of scanBooks(false, true).filter((item) => !item.missing && item.size === buffer.length)) {
        const hash = book.contentHash || await sha256File(absoluteBookPath(book));
        if (!book.contentHash) storage.setPublicationHash(book.id, hash);
        if (hash === contentHash) { duplicate = storage.getPublication(book.id); break; }
      }
    }
    if (duplicate && strategy === 'skip') return res.status(409).json({ error: '这本书已经在书库中', code: 'DUPLICATE', duplicateId: duplicate.id });
    let target = path.join(IMPORT_DIR, fileName);
    if (fs.existsSync(target) || duplicate) {
      const extension = path.extname(fileName); const stem = path.basename(fileName, extension);
      let counter = 2;
      while (fs.existsSync(target)) target = path.join(IMPORT_DIR, `${stem} (${counter++})${extension}`);
    }
    const temp = path.join(IMPORT_DIR, `.import-${crypto.randomUUID()}.tmp`);
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, target);
    catalogCache.at = 0;
    const books = scanBooks(true, true);
    const relativePath = path.relative(ROOT, target).replace(/\\/g, '/');
    const imported = books.find((book) => book.relativePath === relativePath);
    if (!imported) throw new Error('导入后未能建立书目记录');
    storage.setPublicationHash(imported.id, contentHash);
    catalogCache.at = 0;
    res.status(201).json({ ...imported, contentHash, duplicateOf: duplicate?.id || null });
  } catch (error) { res.status(422).json({ error: error.message }); }
});

app.patch('/api/books/:id/metadata', (req, res) => {
  const record = storage.getPublication(req.params.id);
  if (!record) return res.status(404).json({ error: 'Book not found' });
  const values = { title: String(req.body.title || '').trim().slice(0, 240), author: String(req.body.author || '').trim().slice(0, 160), category: String(req.body.category || '').trim().slice(0, 120) };
  storage.updatePublicationMetadata(req.params.id, values); catalogCache.at = 0;
  res.json({ ok: true, ...values });
});

app.post('/api/books/:id/lifecycle', async (req, res) => {
  const action = String(req.body.action || '');
  const record = storage.getPublication(req.params.id);
  if (!record) return res.status(404).json({ error: 'Book not found' });
  try {
    if (action === 'archive') storage.setPublicationStatus(record.id, 'archived');
    else if (action === 'unarchive' || action === 'restore-library') storage.setPublicationStatus(record.id, 'active');
    else if (action === 'remove') storage.setPublicationStatus(record.id, 'removed');
    else if (action === 'trash') {
      const book = getBook(record.id);
      if (!book) throw new Error('原文件不存在');
      const source = absoluteBookPath(book);
      const trashName = `${record.id}--${safeFileName(record.file_name)}`;
      const target = path.join(TRASH_DIR, trashName);
      if (fs.existsSync(target)) throw new Error('回收区已存在同名文件');
      await fsp.rename(source, target);
      storage.trashPublication(record.id, path.relative(ROOT, target).replace(/\\/g, '/'), record.relative_path);
    } else if (action === 'restore-file') {
      if (record.status !== 'trashed' || !record.original_relative_path) throw new Error('该书没有可恢复文件');
      const source = path.resolve(ROOT, record.relative_path); const target = path.resolve(ROOT, record.original_relative_path);
      if (!source.startsWith(TRASH_DIR + path.sep) || !target.startsWith(ROOT + path.sep)) throw new Error('恢复路径无效');
      if (fs.existsSync(target)) throw new Error('原位置已有同名文件');
      await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.rename(source, target);
      storage.restorePublication(record.id, record.original_relative_path);
    } else return res.status(400).json({ error: 'Unsupported lifecycle action' });
    if (req.body.deleteData === true) {
      mutate((state) => { for (const key of ['notes', 'progress', 'chat', 'drawings', 'discussions', 'boards']) delete state[key]?.[record.id]; });
      storage.deletePublicationData(record.id);
    }
    catalogCache.at = 0;
    res.json({ ok: true, id: record.id, action, recoverable: action === 'trash' });
  } catch (error) { res.status(422).json({ error: error.message }); }
});

app.get('/api/books', (_req, res) => res.json(scanBooks()));
app.get('/api/books/:id/content', (req, res) => {
  const book = getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.sendFile(absoluteBookPath(book));
});
app.get('/api/books/:id/assets/:assetId', async (req, res) => {
  const book = getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  const assetId = String(req.params.assetId || '');
  try {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    if (assetId.startsWith('ez-') && book.format === 'EPUB') {
      const resourcePath = Buffer.from(assetId.slice(3), 'base64url').toString('utf8');
      if (!resourcePath || resourcePath.startsWith('../') || !/^image\//.test(imageMime(resourcePath))) return res.status(400).json({ error: 'Invalid image asset' });
      const zip = new AdmZip(absoluteBookPath(book));
      const entry = zip.getEntry(resourcePath);
      if (!entry) return res.status(404).json({ error: 'Image not found' });
      res.type(imageMime(resourcePath)).send(entry.getData());
      return;
    }
    if (!/^[a-z][a-z0-9-]*\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(assetId)) return res.status(400).json({ error: 'Invalid image asset' });
    const directory = path.resolve(ASSET_DIR, book.id);
    const file = path.resolve(directory, assetId);
    if (!file.startsWith(directory + path.sep)) return res.status(400).json({ error: 'Invalid image asset' });
    await fsp.access(file, fs.constants.R_OK);
    res.type(imageMime(file)).sendFile(file);
  } catch { res.status(404).json({ error: 'Image not found' }); }
});

app.get('/api/books/:id/epub-files/*', (req, res) => {
  const book = getBook(req.params.id);
  if (!book || book.format !== 'EPUB') return res.status(404).json({ error: 'EPUB not found' });
  let entryName;
  try { entryName = path.posix.normalize(decodeURIComponent(req.params[0] || '')); } catch { return res.status(400).json({ error: 'Invalid EPUB resource' }); }
  if (!entryName || entryName.startsWith('../') || path.posix.isAbsolute(entryName)) return res.status(400).json({ error: 'Invalid EPUB resource' });
  try {
    const zip = new AdmZip(absoluteBookPath(book));
    const entry = zip.getEntry(entryName);
    if (!entry || entry.isDirectory || entry.header.size > 50 * 1024 * 1024) return res.status(404).json({ error: 'EPUB resource not found' });
    const mime = publicationMime(entryName);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', /\.(x?html?|htm)$/i.test(entryName) ? 'private, max-age=0' : 'public, max-age=31536000, immutable');
    const data = entry.getData();
    if (/\.(x?html?|htm)$/i.test(entryName)) return res.type(mime).send(sanitizePublicationMarkup(data.toString('utf8')));
    res.type(mime).send(data);
  } catch { res.status(404).json({ error: 'EPUB resource not found' }); }
});

app.get('/api/books/:id/pages/:page/images', async (req, res) => {
  const book = getBook(req.params.id);
  const page = Number(req.params.page);
  if (!book || book.format !== 'PDF') return res.status(404).json({ error: 'PDF not found' });
  if (!Number.isInteger(page) || page < 1 || page > 100000) return res.status(400).json({ error: 'Invalid page' });
  const directory = path.join(ASSET_DIR, book.id);
  const metadataFile = path.join(directory, `page-${page}.json`);
  try {
    const cached = JSON.parse(await fsp.readFile(metadataFile, 'utf8'));
    return res.json(cached);
  } catch {}

  let parser;
  try {
    parser = new PDFParse({ data: await fsp.readFile(absoluteBookPath(book)) });
    const result = await parser.getImage({ partial: [page], imageThreshold: 90, imageBuffer: false, imageDataUrl: true });
    const images = result.pages?.find((item) => item.pageNumber === page)?.images || [];
    const blocks = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const assetId = await persistDataImage(book.id, image.dataUrl, 'p');
      if (!assetId) continue;
      blocks.push({ id: `p${page}-image-${index + 1}`, type: 'image', assetId, page, width: image.width || null, height: image.height || null, alt: `第 ${page} 页原书插图 ${index + 1}`, caption: `第 ${page} 页插图 ${index + 1}` });
    }
    const payload = { bookId: book.id, page, images: blocks };
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(metadataFile, JSON.stringify(payload), 'utf8');
    res.json(payload);
  } catch (error) { res.status(422).json({ error: '本页图片提取失败', details: error.message }); }
  finally { if (parser) await parser.destroy().catch(() => {}); }
});
app.get('/api/books/:id/structured-text', async (req, res) => {
  const book = getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  try { res.json(await extractBook(book)); } catch (error) { res.status(422).json({ error: '无法解析该文件', details: error.message }); }
});
app.post('/api/books/:id/resolve-locator', async (req, res) => {
  const book = getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  try {
    const publication = await extractBook(book);
    const locator = resolveLocator(publication, req.body?.locator || req.body || {});
    if (!locator) return res.status(404).json({ error: '无法恢复该阅读位置' });
    res.json(locator);
  } catch (error) { res.status(422).json({ error: error.message }); }
});
app.get('/api/books/:id/toc', async (req, res) => {
  const book = getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  try {
    const data = await extractBook(book);
    res.json({ bookId: book.id, toc: data.toc || [] });
  } catch (error) { res.status(422).json({ error: error.message }); }
});

app.get('/api/books/:id/search', async (req, res) => {
  const q = String(req.query.q || '').trim().toLocaleLowerCase();
  if (!q) return res.json([]);
  const book = getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  try {
    const data = await extractBook(book);
    const results = [];
    for (const chapter of data.chapters) for (const block of chapter.blocks) if (block.text?.toLocaleLowerCase().includes(q)) results.push({ chapterTitle: chapter.title, text: block.text, locator: locatorFor(block, chapter) });
    res.json(results.slice(0, 100));
  } catch (error) { res.status(422).json({ error: error.message }); }
});

app.get('/api/books/:id/progress', (req, res) => res.json(db.progress[req.params.id] || {}));
app.post('/api/books/:id/progress', (req, res) => {
  const { userId = 'local-user', userName = '我', percentage = 0, locator = null } = req.body || {};
  const progress = mutate((state) => {
    state.progress[req.params.id] ||= {};
    const value = { userId, userName, percentage: Math.max(0, Math.min(100, Math.round(Number(percentage) || 0))), locator, updatedAt: new Date().toISOString() };
    state.progress[req.params.id][userId] = value;
    state.readingEvents.push({ id: crypto.randomUUID(), type: 'progress', bookId: req.params.id, userId, percentage: value.percentage, at: value.updatedAt });
    state.readingEvents = state.readingEvents.slice(-2000);
    return value;
  });
  broadcast(`book:${req.params.id}`, { type: 'progress-updated', progress: db.progress[req.params.id] });
  res.json(progress);
});

app.get('/api/books/:id/notes', (req, res) => {
  const userId = req.query.userId;
  const roomId = req.query.roomId;
  const notes = (db.notes[req.params.id] || []).filter((n) => !userId || n.userId === userId || (n.visibility === 'room' && (!roomId || n.roomId === roomId)));
  res.json(notes);
});
app.post('/api/books/:id/notes', (req, res) => {
  const body = req.body || {};
  if (!body.text || !body.locator) return res.status(400).json({ error: 'text and locator are required' });
  const note = mutate((state) => {
    state.notes[req.params.id] ||= [];
    const value = { id: crypto.randomUUID(), text: String(body.text).slice(0, 2000), comment: String(body.comment || '').slice(0, 4000), color: body.color || 'amber', userId: body.userId || 'local-user', userName: body.userName || '我', visibility: body.visibility === 'room' ? 'room' : 'private', roomId: body.roomId || null, locator: body.locator, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.notes[req.params.id].push(value);
    return value;
  });
  broadcast(`book:${req.params.id}`, { type: 'notes-updated' });
  res.status(201).json(note);
});
app.delete('/api/books/:id/notes/:noteId', (req, res) => {
  mutate((state) => {
    state.notes[req.params.id] = (state.notes[req.params.id] || []).filter((n) => n.id !== req.params.noteId);
    for (const key of Object.keys(state.reviewState)) if (key.endsWith(`:${req.params.noteId}`)) delete state.reviewState[key];
  });
  broadcast(`book:${req.params.id}`, { type: 'notes-updated' });
  res.json({ ok: true });
});

app.get('/api/rooms', (req, res) => {
  const userId = req.query.userId;
  res.json(Object.values(db.rooms).filter((room) => !userId || room.members.some((m) => m.userId === userId)));
});
app.post('/api/rooms', (req, res) => {
  const { bookId, name, userId = 'local-user', userName = '我' } = req.body || {};
  if (!bookId || !getBook(bookId)) return res.status(400).json({ error: 'Valid bookId required' });
  const room = mutate((state) => {
    const id = crypto.randomUUID();
    const value = { id, bookId, name: String(name || '共读小组').slice(0, 80), inviteCode: crypto.randomBytes(4).toString('hex'), ownerId: userId, members: [{ userId, userName, role: 'owner', joinedAt: new Date().toISOString() }], milestones: [], createdAt: new Date().toISOString() };
    state.rooms[id] = value;
    return value;
  });
  res.status(201).json(room);
});
app.post('/api/rooms/join', (req, res) => {
  const { inviteCode, userId = 'local-user', userName = '我' } = req.body || {};
  const room = Object.values(db.rooms).find((r) => r.inviteCode === inviteCode);
  if (!room) return res.status(404).json({ error: '邀请码无效' });
  mutate(() => { if (!room.members.some((m) => m.userId === userId)) room.members.push({ userId, userName, role: 'member', joinedAt: new Date().toISOString() }); });
  res.json(room);
});
app.post('/api/rooms/:id/milestones', (req, res) => {
  const room = db.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const milestone = { id: crypto.randomUUID(), title: String(req.body.title || '').slice(0, 120), target: Number(req.body.target || 0), dueAt: req.body.dueAt || null, createdAt: new Date().toISOString() };
  mutate(() => room.milestones.push(milestone));
  res.status(201).json(milestone);
});
app.delete('/api/rooms/:id', (req, res) => {
  const room = db.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (req.query.userId && room.ownerId !== req.query.userId) return res.status(403).json({ error: 'Only the owner can delete this room' });
  mutate((state) => { delete state.rooms[req.params.id]; });
  res.json({ ok: true });
});

app.get('/api/books/:id/discussions', (req, res) => res.json((db.discussions[req.params.id] || []).filter((d) => !req.query.roomId || d.roomId === req.query.roomId)));
app.post('/api/books/:id/discussions', (req, res) => {
  const body = req.body || {};
  if (!body.message || !body.locator) return res.status(400).json({ error: 'message and locator required' });
  const discussion = mutate((state) => {
    state.discussions[req.params.id] ||= [];
    const value = { id: crypto.randomUUID(), roomId: body.roomId || null, userId: body.userId || 'local-user', userName: body.userName || '我', message: String(body.message).slice(0, 4000), quote: String(body.quote || '').slice(0, 1000), locator: body.locator, replies: [], createdAt: new Date().toISOString() };
    state.discussions[req.params.id].push(value);
    return value;
  });
  broadcast(`book:${req.params.id}`, { type: 'discussions-updated' });
  res.status(201).json(discussion);
});
app.post('/api/books/:id/discussions/:discussionId/replies', (req, res) => {
  const discussion = (db.discussions[req.params.id] || []).find((d) => d.id === req.params.discussionId);
  if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
  const reply = { id: crypto.randomUUID(), userId: req.body.userId || 'local-user', userName: req.body.userName || '我', message: String(req.body.message || '').slice(0, 4000), createdAt: new Date().toISOString() };
  mutate(() => discussion.replies.push(reply));
  broadcast(`book:${req.params.id}`, { type: 'discussions-updated' });
  res.status(201).json(reply);
});
app.delete('/api/books/:id/discussions/:discussionId', (req, res) => {
  mutate((state) => { state.discussions[req.params.id] = (state.discussions[req.params.id] || []).filter((item) => item.id !== req.params.discussionId); });
  broadcast(`book:${req.params.id}`, { type: 'discussions-updated' });
  res.json({ ok: true });
});

app.post('/api/books/:id/assistant', async (req, res) => {
  const normalizedInput = normalizeAssistantInput(req.body, req.params.id);
  const { question, selectedText, contextAttachments } = normalizedInput;
  const book = getBook(req.params.id);
  if (!book || !question) return res.status(400).json({ error: 'book and question required' });
  const requestAbort = new AbortController();
  const cancelRequest = () => requestAbort.abort();
  req.once('aborted', cancelRequest);
  res.once('close', () => {
    if (!res.writableEnded) cancelRequest();
  });
  try {
    const requestedIds = [...new Set([
      book.id,
      ...(Array.isArray(req.body.bookIds) ? req.body.bookIds.map(String) : []),
    ])].slice(0, 5);
    const selectedBooks = requestedIds.map((id) => getBook(id)).filter(Boolean);
    const extracted = await Promise.all(selectedBooks.map(async (selectedBook) => ({
      book: selectedBook,
      data: await extractBook(selectedBook),
    })));
    const publications = extracted.map(({ book: selectedBook, data }) => ({
      ...data,
      bookId: selectedBook.id,
      title: selectedBook.title,
      chapters: data.chapters.map((chapter) => ({
        ...chapter,
        blocks: chapter.blocks.map((block) => ({ ...block, locator: locatorFor(block, chapter) })),
      })),
    }));
    const userId = String(req.body.userId || 'local-user');
    const notes = selectedBooks.flatMap((selectedBook) => (db.notes[selectedBook.id] || [])
      .filter((note) => note.userId === userId)
      .slice(-8)
      .map((note) => ({ ...note, bookId: selectedBook.id })));
    const toc = extracted.flatMap(({ book: selectedBook, data }) => (data.toc || [])
      .map((item) => ({ ...item, bookId: selectedBook.id })));
    const questionLocator = normalizedInput.activeLocator;
    res.json(await bookAI.ask({
      question,
      questionSource: normalizedInput.questionSource,
      mode: req.body.mode,
      bookIds: selectedBooks.map((item) => item.id),
      activeLocator: questionLocator,
      useCurrentLocation: req.body.useCurrentLocation,
      userId,
      signal: requestAbort.signal,
      readingContext: {
        books: selectedBooks.map((item) => ({
          id: item.id,
          title: item.title,
          author: item.author,
          format: item.format,
        })),
        toc,
        notes,
        activeLocator: questionLocator,
        selectedText,
        contextAttachments,
      },
    }, publications));
  } catch (error) {
    if (!res.headersSent) res.status(error.code === 'WORKAGENT_CANCELLED' ? 499 : 422).json({ error: error.message });
  } finally {
    req.removeListener('aborted', cancelRequest);
  }
});

app.get('/api/review', (req, res) => {
  const userId = req.query.userId || 'local-user';
  const notes = [];
  for (const [bookId, list] of Object.entries(db.notes)) for (const note of list) if (note.userId === userId) {
    const review = db.reviewState[`${userId}:${note.id}`] || { interval: 0, dueAt: note.createdAt };
    notes.push({ ...note, bookId, book: getBook(bookId)?.title || '未知书籍', review });
  }
  notes.sort((a, b) => new Date(a.review.dueAt) - new Date(b.review.dueAt));
  const events = db.readingEvents.filter((e) => e.userId === userId);
  const days = new Set(events.map((e) => e.at.slice(0, 10))).size;
  const now = Date.now();
  res.json({ queue: notes.filter((note) => new Date(note.review.dueAt).getTime() <= now).slice(0, 20), upcoming: notes.filter((note) => new Date(note.review.dueAt).getTime() > now).slice(0, 10), stats: { readingDays: days, notes: notes.length, finished: Object.values(db.progress).filter((p) => p[userId]?.percentage >= 100).length, due: notes.filter((note) => new Date(note.review.dueAt).getTime() <= now).length } });
});

app.post('/api/review/rate', (req, res) => {
  const { userId = 'local-user', noteId, rating = 'good' } = req.body || {};
  if (!noteId) return res.status(400).json({ error: 'noteId required' });
  const key = `${userId}:${noteId}`;
  const current = db.reviewState[key] || { interval: 0, repetitions: 0 };
  const next = mutate((state) => {
    const intervals = rating === 'again' ? 0 : rating === 'hard' ? Math.max(1, Math.round(current.interval * 1.5) || 1) : rating === 'easy' ? Math.max(4, Math.round(current.interval * 3) || 4) : Math.max(2, Math.round(current.interval * 2.2) || 2);
    const value = { interval: intervals, repetitions: rating === 'again' ? 0 : current.repetitions + 1, lastRating: rating, reviewedAt: new Date().toISOString(), dueAt: new Date(Date.now() + intervals * 86400000).toISOString() };
    state.reviewState[key] = value;
    return value;
  });
  res.json(next);
});

app.get('/api/highlights/search', (req, res) => {
  const userId = req.query.userId || 'local-user';
  const q = String(req.query.q || '').trim().toLocaleLowerCase();
  const results = [];
  if (q) for (const [bookId, list] of Object.entries(db.notes)) for (const note of list) if (note.userId === userId && `${note.text} ${note.comment}`.toLocaleLowerCase().includes(q)) results.push({ ...note, bookId, book: getBook(bookId)?.title || '未知书籍' });
  res.json(results.slice(0, 100));
});

app.get('/api/export/notes', (req, res) => {
  const userId = req.query.userId || 'local-user';
  const lines = ['# 同读 · 阅读笔记导出', '', `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
  for (const [bookId, list] of Object.entries(db.notes)) {
    const own = list.filter((note) => note.userId === userId);
    if (!own.length) continue;
    lines.push(`## ${getBook(bookId)?.title || '未知书籍'}`, '');
    for (const note of own) lines.push(`> ${note.text.replace(/\n/g, '\n> ')}`, '', note.comment || '_无附加笔记_', '', `- 位置：${note.locator?.chapterId || ''} / ${note.locator?.blockId || ''}`, `- 创建：${note.createdAt}`, '');
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="co-reading-notes-${new Date().toISOString().slice(0, 10)}.md"`);
  res.send(lines.join('\n'));
});

const channels = new Map();
function subscribe(channel, ws, user) { channels.set(channel, channels.get(channel) || new Map()); channels.get(channel).set(ws, user); }
function unsubscribe(ws) { for (const [channel, clients] of channels) { clients.delete(ws); if (!clients.size) channels.delete(channel); } }
function broadcast(channel, message, except = null) { for (const ws of channels.get(channel)?.keys() || []) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'subscribe' && data.bookId) {
        const channel = `book:${data.bookId}`;
        subscribe(channel, ws, { userId: data.userId, userName: data.userName });
        broadcast(channel, { type: 'presence', users: [...channels.get(channel).values()] });
      }
    } catch {}
  });
  ws.on('close', () => unsubscribe(ws));
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html')));
server.listen(PORT, () => {
  const capabilities = bookAI.capabilities();
  console.log(`Co-reading v${APP_VERSION} running at http://localhost:${PORT}`);
  console.log(`AI protocol: ${capabilities.workagent?.contextAdapter || 'none'} / ${capabilities.workagent?.answerNormalizer || 'none'} / ${capabilities.architecture?.verifier || 'none'}`);
});
