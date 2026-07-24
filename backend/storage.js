const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class SQLiteStorage {
  constructor(databaseFile, legacyFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.database = new Database(databaseFile);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS state_segments (
        segment TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_index_state (
        book_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        original_relative_path TEXT,
        file_name TEXT NOT NULL,
        format TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        modified_at TEXT,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','removed','trashed','missing')),
        title_override TEXT,
        author_override TEXT,
        category_override TEXT,
        managed INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT,
        missing_at TEXT
      );
      CREATE INDEX IF NOT EXISTS publications_status_idx ON publications(status);
      CREATE INDEX IF NOT EXISTS publications_hash_idx ON publications(content_hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS publication_fts USING fts5(
        book_id UNINDEXED,
        chapter_id UNINDEXED,
        block_id UNINDEXED,
        chapter_title,
        body,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS ai_runs (
        id TEXT PRIMARY KEY,
        book_ids_json TEXT NOT NULL,
        question TEXT NOT NULL,
        mode TEXT NOT NULL,
        intent TEXT NOT NULL,
        provider TEXT NOT NULL,
        fallback INTEGER NOT NULL DEFAULT 0,
        refused INTEGER NOT NULL DEFAULT 0,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        verification_json TEXT,
        provider_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_runs_created_idx ON ai_runs(created_at);
    `);
    const publicationColumns = this.database.pragma('table_info(publications)');
    if (!publicationColumns.some((column) => column.name === 'original_relative_path')) {
      this.database.exec('ALTER TABLE publications ADD COLUMN original_relative_path TEXT');
    }
    this.legacyFile = legacyFile;
    this.writeSegment = this.database.prepare(`
      INSERT INTO state_segments(segment, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(segment) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `);
    this.saveTransaction = this.database.transaction((state) => {
      const now = new Date().toISOString();
      for (const [segment, value] of Object.entries(state)) this.writeSegment.run(segment, JSON.stringify(value), now);
    });
    this.indexTransaction = this.database.transaction((publication) => {
      this.database.prepare('DELETE FROM publication_fts WHERE book_id = ?').run(publication.bookId);
      const insert = this.database.prepare('INSERT INTO publication_fts(book_id, chapter_id, block_id, chapter_title, body) VALUES (?, ?, ?, ?, ?)');
      for (const chapter of publication.chapters || []) {
        for (const block of chapter.blocks || []) if (block.text) insert.run(publication.bookId, chapter.id, block.id, chapter.title || '', block.text);
      }
      this.database.prepare(`INSERT INTO publication_index_state(book_id, fingerprint, indexed_at) VALUES (?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET fingerprint=excluded.fingerprint, indexed_at=excluded.indexed_at`).run(publication.bookId, publication.fingerprint || '', new Date().toISOString());
    });
    this.syncCatalogTransaction = this.database.transaction((books) => {
      const now = new Date().toISOString();
      const seen = [];
      const upsert = this.database.prepare(`INSERT INTO publications(id, relative_path, file_name, format, size, modified_at, status, managed, added_at, updated_at, last_seen_at)
        VALUES (@id, @relativePath, @fileName, @format, @size, @modifiedAt, 'active', @managed, @now, @now, @now)
        ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path, file_name=excluded.file_name, format=excluded.format,
        size=excluded.size, modified_at=excluded.modified_at, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at,
        missing_at=NULL, status=CASE WHEN publications.status='missing' THEN 'active' ELSE publications.status END`);
      for (const book of books) {
        upsert.run({
          id: book.id,
          relativePath: book.relativePath,
          fileName: book.fileName,
          format: book.format,
          size: book.size,
          modifiedAt: book.modifiedAt,
          managed: book.managed ? 1 : 0,
          now,
        });
        seen.push(book.id);
      }
      if (seen.length) {
        const placeholders = seen.map(() => '?').join(',');
        this.database.prepare(`UPDATE publications SET status='missing', missing_at=COALESCE(missing_at, ?), updated_at=? WHERE id NOT IN (${placeholders}) AND status IN ('active','archived')`).run(now, now, ...seen);
      }
    });
  }

  load(fallbackState) {
    const rows = this.database.prepare('SELECT segment, value_json FROM state_segments').all();
    if (rows.length) {
      const state = {};
      for (const row of rows) {
        try { state[row.segment] = JSON.parse(row.value_json); } catch {}
      }
      return { ...fallbackState, ...state };
    }
    let legacy = fallbackState;
    try {
      legacy = { ...fallbackState, ...JSON.parse(fs.readFileSync(this.legacyFile, 'utf8')) };
      const backup = `${this.legacyFile}.migration-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(this.legacyFile, backup);
    } catch {}
    this.save(legacy);
    this.database.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
    return legacy;
  }

  save(state) { this.saveTransaction(state); }
  indexPublication(publication) {
    const indexed = this.database.prepare('SELECT fingerprint FROM publication_index_state WHERE book_id = ?').get(publication.bookId);
    if (indexed?.fingerprint === (publication.fingerprint || '')) return;
    this.indexTransaction(publication);
  }
  recordAIRun(run) {
    this.database.prepare(`INSERT INTO ai_runs(
      id, book_ids_json, question, mode, intent, provider, fallback, refused,
      evidence_count, duration_ms, verification_json, provider_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id,
      JSON.stringify(run.bookIds || []),
      run.question,
      run.mode,
      run.intent,
      run.provider,
      run.fallback ? 1 : 0,
      run.refused ? 1 : 0,
      Number(run.evidenceCount || 0),
      Number(run.durationMs || 0),
      JSON.stringify(run.verification || {}),
      run.providerError || null,
      new Date().toISOString()
    );
  }
  syncCatalog(books) { this.syncCatalogTransaction(books); }
  listPublications() { return this.database.prepare('SELECT * FROM publications ORDER BY added_at DESC').all(); }
  getPublication(id) { return this.database.prepare('SELECT * FROM publications WHERE id = ?').get(id); }
  findPublicationByHash(hash) { return this.database.prepare("SELECT * FROM publications WHERE content_hash = ? AND status != 'trashed' LIMIT 1").get(hash); }
  setPublicationHash(id, hash) { this.database.prepare('UPDATE publications SET content_hash=?, updated_at=? WHERE id=?').run(hash, new Date().toISOString(), id); }
  setPublicationStatus(id, status, relativePath = null) {
    const now = new Date().toISOString();
    if (relativePath) this.database.prepare('UPDATE publications SET status=?, relative_path=?, updated_at=? WHERE id=?').run(status, relativePath, now, id);
    else this.database.prepare('UPDATE publications SET status=?, updated_at=? WHERE id=?').run(status, now, id);
  }
  trashPublication(id, trashRelativePath, originalRelativePath) {
    this.database.prepare("UPDATE publications SET status='trashed', relative_path=?, original_relative_path=?, updated_at=? WHERE id=?")
      .run(trashRelativePath, originalRelativePath, new Date().toISOString(), id);
  }
  restorePublication(id, relativePath) {
    this.database.prepare("UPDATE publications SET status='active', relative_path=?, original_relative_path=NULL, missing_at=NULL, updated_at=? WHERE id=?")
      .run(relativePath, new Date().toISOString(), id);
  }
  updatePublicationMetadata(id, values) {
    this.database.prepare('UPDATE publications SET title_override=?, author_override=?, category_override=?, updated_at=? WHERE id=?')
      .run(values.title || null, values.author || null, values.category || null, new Date().toISOString(), id);
  }
  deletePublicationData(id) {
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM publication_fts WHERE book_id=?').run(id);
      this.database.prepare('DELETE FROM publication_index_state WHERE book_id=?').run(id);
    })();
  }
  close() { this.database.close(); }
}

module.exports = { SQLiteStorage };
