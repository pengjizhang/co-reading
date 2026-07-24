import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BookOpen, Brain, CheckCircle2, Download, Edit3, FileText,
  FolderMinus, Highlighter, Library as LibraryIcon, MoreVertical, RefreshCw, Search,
  Sparkles, Trash2, UploadCloud, X
} from 'lucide-react';

const ACCEPTED = ['.epub', '.pdf', '.docx'];

const formatBytes = (bytes) => {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};

const timeAgo = (value) => {
  if (!value) return '尚未开始';
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return '刚刚阅读';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
};

const lifecycleLabels = { archived: '已归档', removed: '已移出', trashed: '可恢复删除', missing: '文件缺失' };

export default function Library({ api, identity, onSelectBook }) {
  const [payload, setPayload] = useState({ books: [], totals: {} });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importItems, setImportItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [menuBook, setMenuBook] = useState(null);
  const [editBook, setEditBook] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const inputRef = useRef(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const [libraryResponse, reviewResponse] = await Promise.all([
        fetch(`${api}/library?userId=${identity.userId}${refresh ? '&refresh=1' : ''}`),
        fetch(`${api}/review?userId=${identity.userId}`)
      ]);
      if (!libraryResponse.ok) throw new Error('无法读取本地书库');
      setPayload(await libraryResponse.json());
      if (reviewResponse.ok) setReview(await reviewResponse.json());
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const lifecycleMatch = (book) => {
    if (filter === 'archived') return book.libraryStatus === 'archived';
    if (filter === 'removed') return ['removed', 'trashed'].includes(book.libraryStatus);
    if (filter === 'missing') return book.libraryStatus === 'missing';
    if (filter === 'notes') return book.libraryStatus === 'active' && book.noteCount > 0;
    if (['reading', 'unread', 'finished'].includes(filter)) return book.libraryStatus === 'active' && book.status === filter;
    return filter === 'all' ? book.libraryStatus === 'active' : true;
  };
  const books = useMemo(() => payload.books
    .filter(lifecycleMatch)
    .filter((book) => `${book.title} ${book.author || ''} ${book.category}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => new Date(b.progress?.updatedAt || b.modifiedAt || 0) - new Date(a.progress?.updatedAt || a.modifiedAt || 0)), [payload.books, query, filter]);
  const continueBook = payload.books.filter((book) => book.libraryStatus === 'active' && book.status === 'reading' && book.canOpen)
    .sort((a, b) => new Date(b.progress.updatedAt) - new Date(a.progress.updatedAt))[0];

  const uploadOne = async (file, strategy = 'skip') => {
    setImportItems((items) => items.map((item) => item.file === file ? { ...item, state: 'uploading', message: '正在校验并导入…' } : item));
    try {
      const response = await fetch(`${api}/library/import?name=${encodeURIComponent(file.name)}&strategy=${strategy}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file
      });
      const result = await response.json();
      if (response.status === 409) {
        setImportItems((items) => items.map((item) => item.file === file ? { ...item, state: 'duplicate', message: result.error } : item));
        return;
      }
      if (!response.ok) throw new Error(result.error || '导入失败');
      setImportItems((items) => items.map((item) => item.file === file ? { ...item, state: 'done', message: result.duplicateOf ? '已作为副本保留' : '已加入书库' } : item));
      setNotice(`《${result.title || file.name}》已加入书库`);
      await load(true);
    } catch (cause) {
      setImportItems((items) => items.map((item) => item.file === file ? { ...item, state: 'error', message: cause.message } : item));
    }
  };

  const addFiles = (fileList) => {
    const files = [...fileList].filter((file) => ACCEPTED.includes(`.${file.name.split('.').pop()?.toLowerCase()}`));
    if (!files.length) { setNotice('仅支持 EPUB、PDF 和 DOCX'); return; }
    setImportOpen(true);
    setImportItems((items) => [...items, ...files.map((file) => ({ file, state: 'pending', message: formatBytes(file.size) }))]);
    files.forEach((file) => uploadOne(file));
  };

  const lifecycle = async (book, action) => {
    const response = await fetch(`${api}/books/${book.id}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败');
    const messages = { archive: '已归档', unarchive: '已回到书架', remove: '已从书架移出，原文件和笔记均保留', trash: '文件已移入可恢复区', 'restore-file': '文件已恢复', 'restore-library': '已恢复到书架' };
    setNotice(messages[action]);
    setMenuBook(null);
    await load(true);
  };

  const requestLifecycle = (book, action) => {
    if (action === 'remove' || action === 'trash') setConfirmation({ book, action });
    else lifecycle(book, action).catch((cause) => setNotice(cause.message));
  };

  const openBook = (book) => {
    if (!book.canOpen) return;
    onSelectBook(book);
  };

  return (
    <main className={`library-page ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
      {dragging && <div className="library-drop-overlay"><UploadCloud size={42} /><strong>松开即可加入书库</strong><span>支持 EPUB、PDF、DOCX</span></div>}
      {notice && <div className="library-notice" role="status"><CheckCircle2 size={17} />{notice}</div>}
      <section className="library-hero">
        <div>
          <p className="eyebrow"><Sparkles size={14} /> 今天，从上次停下的地方继续</p>
          <h1>{continueBook ? `继续读《${continueBook.title}》` : '把注意力还给阅读'}</h1>
          <p>{continueBook ? `${timeAgo(continueBook.progress.updatedAt)} · 已读 ${continueBook.progress.percentage}%` : '书籍留在本机，笔记属于你；需要时再邀请朋友一起读。'}</p>
          {continueBook && <button className="primary-action" onClick={() => openBook(continueBook)}><BookOpen size={18} /> 继续阅读</button>}
        </div>
        <div className="hero-stats" aria-label="阅读概览">
          <div><strong>{payload.totals.reading || 0}</strong><span>正在读</span></div>
          <div><strong>{payload.totals.notes || 0}</strong><span>条笔记</span></div>
          <div><strong>{review?.stats?.readingDays || 0}</strong><span>阅读日</span></div>
        </div>
      </section>

      <section className="library-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="书库筛选">
          {[['all', '全部'], ['reading', '在读'], ['unread', '未读'], ['finished', '读完'], ['notes', '有笔记'], ['archived', `归档 ${payload.totals.archived || ''}`], ['removed', `已移出 ${payload.totals.removed || ''}`], ['missing', `文件异常 ${payload.totals.missing || ''}`], ['review', '今日回顾']].map(([value, label]) => (
            <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <div className="toolbar-actions">
          <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索书名、作者或分类" /></label>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".epub,.pdf,.docx" multiple onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
          <button className="import-button" onClick={() => inputRef.current?.click()}><UploadCloud size={17} /> 导入书籍</button>
          <button className="icon-button" title="重新扫描书库" onClick={() => load(true)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>
        </div>
      </section>

      {error && <div className="error-state"><strong>书库暂时不可用</strong><span>{error}</span><button onClick={() => load()}>重试</button></div>}
      {!error && loading && <div className="loading-state"><RefreshCw className="spin" /> 正在整理本地书籍…</div>}
      {!error && !loading && filter !== 'review' && books.length === 0 && <div className="empty-state"><LibraryIcon /><h2>这里还没有匹配的书</h2><p>可以调整筛选，或直接拖入 EPUB、PDF、DOCX。</p><button className="import-button" onClick={() => inputRef.current?.click()}><UploadCloud size={17} /> 导入第一本书</button></div>}

      {!loading && filter === 'review' && <ReviewPanel api={api} identity={identity} review={review} onRefresh={() => load()} />}
      {!loading && filter !== 'review' && books.length > 0 && (
        <section className="book-grid" aria-label="书籍列表">
          {books.map((book) => (
            <article className={`book-card ${book.canOpen ? '' : 'unavailable'}`} key={book.id} onClick={() => openBook(book)}>
              <button className="book-menu-trigger" aria-label={`管理 ${book.title}`} onClick={(event) => { event.stopPropagation(); setMenuBook(menuBook?.id === book.id ? null : book); }}><MoreVertical size={18} /></button>
              {book.libraryStatus !== 'active' && <span className={`lifecycle-badge ${book.libraryStatus}`}>{lifecycleLabels[book.libraryStatus]}</span>}
              <button className={`book-cover format-${book.format.toLowerCase()}`} aria-label={`打开 ${book.title}`} disabled={!book.canOpen}>
                <span className="cover-format">{book.format}</span><FileText size={38} /><small>{book.category}</small>
              </button>
              <div className="book-card-body">
                <p className="book-kicker">{book.author || book.category}</p>
                <h2 title={book.name}>{book.title}</h2>
                <div className="book-meta"><span>{formatBytes(book.size)}</span><span><Highlighter size={13} /> {book.noteCount}</span></div>
                <div className="book-progress"><div><span>{book.status === 'finished' ? '已读完' : timeAgo(book.progress?.updatedAt)}</span><strong>{book.progress?.percentage || 0}%</strong></div><i><b style={{ width: `${book.progress?.percentage || 0}%` }} /></i></div>
              </div>
              {menuBook?.id === book.id && <BookMenu book={book} onEdit={() => { setEditBook(book); setMenuBook(null); }} onAction={(action) => requestLifecycle(book, action)} onClose={() => setMenuBook(null)} />}
            </article>
          ))}
        </section>
      )}

      {importOpen && <ImportDialog items={importItems} onKeep={(file) => uploadOne(file, 'keep')} onClose={() => { setImportOpen(false); setImportItems([]); }} onBrowse={() => inputRef.current?.click()} />}
      {editBook && <MetadataDialog api={api} book={editBook} onClose={() => setEditBook(null)} onSaved={async () => { setEditBook(null); setNotice('书籍信息已更新'); await load(true); }} />}
      {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => {
        const current = confirmation; setConfirmation(null);
        lifecycle(current.book, current.action).catch((cause) => setNotice(cause.message));
      }} />}
    </main>
  );
}

function BookMenu({ book, onEdit, onAction, onClose }) {
  return <div className="book-actions-menu" onClick={(event) => event.stopPropagation()}>
    <button className="menu-close" aria-label="关闭" onClick={onClose}><X size={14} /></button>
    <button onClick={onEdit}><Edit3 size={15} /> 编辑书籍信息</button>
    {book.libraryStatus === 'active' && <button onClick={() => onAction('archive')}><Archive size={15} /> 归档</button>}
    {book.libraryStatus === 'archived' && <button onClick={() => onAction('unarchive')}><ArchiveRestore size={15} /> 回到书架</button>}
    {book.libraryStatus === 'removed' && <button onClick={() => onAction('restore-library')}><ArchiveRestore size={15} /> 恢复到书架</button>}
    {book.libraryStatus === 'trashed' && <button onClick={() => onAction('restore-file')}><ArchiveRestore size={15} /> 恢复文件与书籍</button>}
    {!['removed', 'trashed', 'missing'].includes(book.libraryStatus) && <button onClick={() => onAction('remove')}><FolderMinus size={15} /> 从书架移出</button>}
    {!['trashed', 'missing'].includes(book.libraryStatus) && <button className="danger" onClick={() => onAction('trash')}><Trash2 size={15} /> 删除文件…</button>}
  </div>;
}

function ImportDialog({ items, onKeep, onClose, onBrowse }) {
  const busy = items.some((item) => ['pending', 'uploading'].includes(item.state));
  return <div className="modal-backdrop"><section className="management-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
    <header><div><p className="eyebrow"><UploadCloud size={14} /> 本地导入</p><h2 id="import-title">加入新书</h2></div><button className="icon-button" onClick={onClose} disabled={busy}><X size={18} /></button></header>
    <p className="modal-help">书籍会复制到“同读书库”，原文件不会改动；导入前会校验格式并识别重复内容。</p>
    <div className="import-list">{items.map((item, index) => <div className={`import-item ${item.state}`} key={`${item.file.name}-${index}`}>
      <FileText size={20} /><div><strong>{item.file.name}</strong><span>{item.message}</span></div>
      {item.state === 'uploading' && <RefreshCw size={17} className="spin" />}
      {item.state === 'done' && <CheckCircle2 size={18} />}
      {item.state === 'duplicate' && <button onClick={() => onKeep(item.file)}>仍保留副本</button>}
    </div>)}</div>
    <footer><button className="secondary-action" onClick={onBrowse}>继续选择</button><button className="primary-action" onClick={onClose} disabled={busy}>完成</button></footer>
  </section></div>;
}

function MetadataDialog({ api, book, onClose, onSaved }) {
  const [form, setForm] = useState({ title: book.title || '', author: book.author || '', category: book.category || '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async (event) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await fetch(`${api}/books/${book.id}/metadata`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '保存失败'); await onSaved();
    } catch (cause) { setError(cause.message); setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="management-modal metadata-form" onSubmit={save}>
    <header><div><p className="eyebrow"><Edit3 size={14} /> 书籍信息</p><h2>编辑元数据</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></header>
    <label>书名<input value={form.title} required onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
    <label>作者<input value={form.author} placeholder="可选" onChange={(event) => setForm({ ...form, author: event.target.value })} /></label>
    <label>分类<input value={form.category} placeholder="例如：历史、技术" onChange={(event) => setForm({ ...form, category: event.target.value })} /></label>
    <small>只修改书架显示信息，不会重写原书文件。</small>{error && <p className="form-error">{error}</p>}
    <footer><button type="button" className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" disabled={saving}>{saving ? '保存中…' : '保存'}</button></footer>
  </form></div>;
}

function ConfirmDialog({ confirmation, onCancel, onConfirm }) {
  const removingFile = confirmation.action === 'trash';
  return <div className="modal-backdrop"><section className="management-modal confirm-modal" role="alertdialog" aria-modal="true">
    <div className="danger-icon"><Trash2 size={22} /></div><h2>{removingFile ? '删除这本书的文件？' : '从书架移出这本书？'}</h2>
    <p>《{confirmation.book.title}》</p>
    <div className="safety-note">{removingFile ? '文件会移入应用的可恢复区，笔记和阅读进度默认保留，之后可以一键恢复。' : '原书文件、笔记和阅读进度都不会删除，可随时从“已移出”恢复。'}</div>
    <footer><button className="secondary-action" onClick={onCancel}>取消</button><button className={removingFile ? 'danger-action' : 'primary-action'} onClick={onConfirm}>{removingFile ? '移入可恢复区' : '确认移出'}</button></footer>
  </section></div>;
}

function ReviewPanel({ api, identity, review, onRefresh }) {
  const [active, setActive] = useState(0); const queue = review?.queue || []; const item = queue[active];
  const rate = async (rating) => { if (!item) return; await fetch(`${api}/review/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: identity.userId, noteId: item.id, rating }) }); if (active < queue.length - 1) setActive(active + 1); else { setActive(0); onRefresh(); } };
  return <section className="review-page"><div className="review-summary"><div><p className="eyebrow"><Brain size={14} /> 让重要内容再次出现</p><h2>今日回顾</h2><p>用简单的间隔复习，把划线从“收藏过”变成“真正记得”。</p></div><div className="review-numbers"><span><strong>{review?.stats?.due || 0}</strong>今日待复习</span><span><strong>{review?.stats?.finished || 0}</strong>已读完</span><a href={`${api}/export/notes?userId=${identity.userId}`}><Download size={15} /> 导出 Markdown</a></div></div>{item ? <article className="review-card"><div className="review-card-head"><span>{item.book}</span><small>{active + 1} / {queue.length}</small></div><blockquote>{item.text}</blockquote>{item.comment && <p>{item.comment}</p>}<div className="review-rating"><button onClick={() => rate('again')}>没记住<small>稍后再看</small></button><button onClick={() => rate('hard')}>有点难<small>1 天后</small></button><button onClick={() => rate('good')}>记得<small>按间隔复习</small></button><button onClick={() => rate('easy')}>很熟悉<small>延长间隔</small></button></div></article> : <div className="review-complete"><span>✓</span><h3>今天的回顾完成了</h3><p>新的划线会自动进入后续回顾队列。</p></div>}</section>;
}
