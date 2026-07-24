import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Bot, ChevronLeft, ChevronRight, Highlighter, LayoutPanelLeft, MessageCircle, Minus, Plus, RefreshCw, Settings2, X, ZoomIn, ZoomOut } from 'lucide-react';
import CollaborationPane from './CollaborationPane';
import { ImageBlock, PdfPageImages } from './ReaderMedia';
import useReadingInput from '../hooks/useReadingInput';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, sidebarWidthFromPointer } from '../lib/sidebarResize';

function publicationLocator(block, chapter) {
  const blocks = chapter?.blocks || [];
  const index = Math.max(0, blocks.findIndex((item) => item.id === block?.id));
  const exact = String(block?.text || block?.caption || block?.alt || '').replace(/\s+/g, ' ').trim();
  return { version: 2, parserVersion: 'publication-v4', chapterId: chapter?.id || null, href: chapter?.href || null, blockId: block?.id || null, sourceAnchor: block?.sourceAnchor || null, sourceOrdinal: block?.sourceOrdinal ?? index, progression: blocks.length > 1 ? index / (blocks.length - 1) : 0, page: block?.page || chapter?.page || null, assetId: block?.assetId || null, textQuote: exact.slice(0, 180), quote: { exact: exact.slice(0, 500), prefix: exact.slice(0, 48), suffix: exact.slice(-48) } };
}

function HighlightedText({ block, notes }) {
  const matches = notes.filter((note) => note.locator?.blockId === block.id && note.text && block.text.includes(note.text));
  if (!matches.length) return block.text;
  const segments = [];
  let cursor = 0;
  [...matches].sort((a, b) => block.text.indexOf(a.text) - block.text.indexOf(b.text)).forEach((note) => {
    const start = block.text.indexOf(note.text, cursor);
    if (start < cursor) return;
    if (start > cursor) segments.push(block.text.slice(cursor, start));
    segments.push(<mark key={note.id} className={`reader-highlight color-${note.color}`} title={note.comment || (note.visibility === 'room' ? '共读划线' : '私人划线')}>{note.text}</mark>);
    cursor = start + note.text.length;
  });
  if (cursor < block.text.length) segments.push(block.text.slice(cursor));
  return segments;
}

function scrollToSettled(element, target) {
  const destination = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight));
  if (Math.abs(element.scrollTop - destination) <= 2) return Promise.resolve();
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) { element.scrollTop = destination; return Promise.resolve(); }
  return new Promise((resolve) => {
    let finished = false;
    let last = element.scrollTop;
    let stableFrames = 0;
    const startedAt = performance.now();
    const finish = () => {
      if (finished) return;
      finished = true;
      element.removeEventListener('scrollend', finish);
      resolve();
    };
    const observe = () => {
      if (finished) return;
      const current = element.scrollTop;
      stableFrames = Math.abs(current - last) < .5 ? stableFrames + 1 : 0;
      last = current;
      if ((Math.abs(current - destination) <= 2 && stableFrames >= 2) || performance.now() - startedAt > 900) return finish();
      requestAnimationFrame(observe);
    };
    element.addEventListener('scrollend', finish, { once: true });
    element.scrollTo({ top: destination, behavior: 'smooth' });
    requestAnimationFrame(observe);
  });
}

export default function Reader({ api, book, identity, ws, connection, onBack }) {
  const [documentData, setDocumentData] = useState(null);
  const [toc, setToc] = useState([]);
  const [notes, setNotes] = useState([]);
  const [discussions, setDiscussions] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState(book.format === 'PDF' ? 'original' : 'reflow');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(localStorage.getItem('coreading.sidebarWidth')));
  const [activePane, setActivePane] = useState('toc');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('coreading.fontSize') || 19));
  const [theme, setTheme] = useState(() => localStorage.getItem('coreading.theme') || 'paper');
  const [lineHeight, setLineHeight] = useState(() => Number(localStorage.getItem('coreading.lineHeight') || 1.85));
  const [readingFlow, setReadingFlow] = useState(() => localStorage.getItem('coreading.readingFlow') || 'continuous');
  const [pageInfo, setPageInfo] = useState({ current: 1, total: 1 });
  const [navHint, setNavHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [activeLocator, setActiveLocator] = useState(null);
  const [selection, setSelection] = useState(null);
  const [assistantSelection, setAssistantSelection] = useState(null);
  const [composer, setComposer] = useState(null);
  const [comment, setComment] = useState('');
  const [imageViewer, setImageViewer] = useState(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [epubMarkup, setEpubMarkup] = useState('');
  const scrollRef = useRef(null);
  const epubFrameRef = useRef(null);
  const saveTimer = useRef(null);
  const restored = useRef(false);
  const navHintTimer = useRef(null);
  const turnBusy = useRef(false);
  const layoutAnchor = useRef(null);

  const loadSocial = useCallback(async () => {
    const query = `userId=${identity.userId}${roomId ? `&roomId=${roomId}` : ''}`;
    const [noteResponse, discussionResponse, roomResponse] = await Promise.all([
      fetch(`${api}/books/${book.id}/notes?${query}`),
      fetch(`${api}/books/${book.id}/discussions${roomId ? `?roomId=${roomId}` : ''}`),
      fetch(`${api}/rooms?userId=${identity.userId}`)
    ]);
    if (noteResponse.ok) setNotes(await noteResponse.json());
    if (discussionResponse.ok) setDiscussions(await discussionResponse.json());
    if (roomResponse.ok) setRooms((await roomResponse.json()).filter((room) => room.bookId === book.id));
  }, [api, book.id, identity.userId, roomId]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); restored.current = false;
    try {
      const [docResponse, tocResponse, progressResponse] = await Promise.all([
        fetch(`${api}/books/${book.id}/structured-text`),
        fetch(`${api}/books/${book.id}/toc`),
        fetch(`${api}/books/${book.id}/progress`)
      ]);
      if (!docResponse.ok) throw new Error((await docResponse.json()).error || '正文解析失败');
      const [doc, tocPayload, progressPayload] = await Promise.all([docResponse.json(), tocResponse.ok ? tocResponse.json() : { toc: [] }, progressResponse.ok ? progressResponse.json() : {}]);
      setDocumentData(doc); setToc(tocPayload.toc || []);
      const saved = progressPayload[identity.userId];
      if (saved) { setProgress(saved.percentage || 0); setActiveLocator(saved.locator || null); }
      if (book.format === 'DOCX' || doc.isImageScan) setMode('reflow');
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  }, [api, book.id, book.format, identity.userId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSocial(); }, [roomId]);
  useEffect(() => { localStorage.setItem('coreading.fontSize', String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem('coreading.lineHeight', String(lineHeight)); }, [lineHeight]);
  useEffect(() => { localStorage.setItem('coreading.theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('coreading.readingFlow', readingFlow); }, [readingFlow]);
  useEffect(() => { localStorage.setItem('coreading.sidebarWidth', String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => {
    const clampOnResize = () => setSidebarWidth((current) => clampSidebarWidth(current));
    window.addEventListener('resize', clampOnResize);
    return () => window.removeEventListener('resize', clampOnResize);
  }, []);

  useEffect(() => {
    if (!ws) return undefined;
    const handler = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'notes-updated' || data.type === 'discussions-updated') loadSocial();
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, loadSocial]);

  useEffect(() => {
    if (loading || restored.current || mode !== 'reflow' || !activeLocator?.blockId) return;
    requestAnimationFrame(() => document.getElementById(activeLocator.blockId)?.scrollIntoView({ block: 'start' }));
    restored.current = true;
  }, [loading, activeLocator, mode]);

  const persistProgress = (percentage, locator) => {
    setProgress(percentage); setActiveLocator(locator);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => fetch(`${api}/books/${book.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, percentage, locator }) }), 350);
  };

  const updatePageInfo = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const step = Math.max(1, element.clientHeight);
    const total = Math.max(1, Math.ceil(element.scrollHeight / step));
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    const current = maxScroll > 0 && element.scrollTop >= maxScroll - 2 ? total : Math.max(1, Math.min(total, Math.floor(element.scrollTop / step) + 1));
    setPageInfo((previous) => previous.current === current && previous.total === total ? previous : { current, total });
  }, []);

  const showNavHint = useCallback((text) => {
    setNavHint(text); clearTimeout(navHintTimer.current);
    navHintTimer.current = setTimeout(() => setNavHint(''), 1100);
  }, []);

  const onScroll = (event) => {
    const element = event.currentTarget;
    updatePageInfo();
    const chapterFraction = element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
    const chapterCount = Math.max(1, documentData?.chapters?.length || 1);
    const currentChapter = Math.max(0, documentData.chapters.findIndex((chapter) => chapter.id === activeLocator?.chapterId));
    const percentage = Math.max(0, Math.min(100, Math.round(((currentChapter + chapterFraction) / chapterCount) * 100)));
    const blocks = [...element.querySelectorAll('[data-block-id]')];
    const visible = blocks.find((node) => node.getBoundingClientRect().top >= 70) || blocks.at(-1);
    if (visible) {
      layoutAnchor.current = { blockId: visible.dataset.blockId, top: visible.getBoundingClientRect().top };
      const chapter = documentData.chapters.find((item) => item.id === visible.dataset.chapterId);
      const block = chapter?.blocks.find((item) => item.id === visible.dataset.blockId);
      persistProgress(percentage, block && chapter ? publicationLocator(block, chapter) : { chapterId: visible.dataset.chapterId, blockId: visible.dataset.blockId, page: visible.dataset.page ? Number(visible.dataset.page) : null, textQuote: visible.textContent.slice(0, 180) });
    }
  };

  const jumpTo = async (locator) => {
    if (!locator) return;
    let resolved = locator;
    const exists = documentData?.chapters?.some((chapter) => chapter.blocks.some((block) => block.id === locator.blockId));
    if (!exists) {
      try {
        const response = await fetch(`${api}/books/${book.id}/resolve-locator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator }) });
        if (response.ok) resolved = await response.json();
      } catch {}
    }
    if (mode === 'original' && resolved.page) {
      document.querySelector('.pdf-frame')?.setAttribute('src', `${api}/books/${book.id}/content#page=${resolved.page}`);
    } else if (mode === 'standard' && book.format === 'EPUB') {
      setActiveLocator(resolved);
    } else {
      setMode('reflow');
      setTimeout(() => document.getElementById(resolved.blockId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    }
    setActiveLocator(resolved);
  };

  const handleSelection = () => {
    const selected = window.getSelection();
    const text = selected?.toString().trim();
    if (!text || text.length > 2000) return setSelection(null);
    const anchor = selected.anchorNode?.parentElement?.closest('[data-block-id]');
    if (!anchor) return setSelection(null);
    const chapter = documentData?.chapters?.find((item) => item.id === anchor.dataset.chapterId);
    const block = chapter?.blocks?.find((item) => item.id === anchor.dataset.blockId);
    const locator = block && chapter ? publicationLocator(block, chapter) : { chapterId: anchor.dataset.chapterId, blockId: anchor.dataset.blockId, page: anchor.dataset.page ? Number(anchor.dataset.page) : null, textQuote: text.slice(0, 180) };
    setSelection({
      text,
      bookId: book.id,
      chapterTitle: chapter?.title || '',
      locator: { ...locator, textQuote: text.slice(0, 180), quote: { exact: text.slice(0, 500), prefix: text.slice(0, 48), suffix: text.slice(-48) } },
    });
  };

  const askSelection = () => {
    if (!selection?.text || selection.kind === 'image') return;
    setAssistantSelection({ ...selection, bookId: selection.bookId || book.id });
    setSelection(null);
    setComposer(null);
    setActivePane('assistant');
    setSidebarOpen(true);
    window.getSelection()?.removeAllRanges();
  };

  const startSidebarResize = (event) => {
    if (window.matchMedia('(max-width: 650px)').matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    const move = (moveEvent) => {
      latestWidth = sidebarWidthFromPointer(startWidth, startX, moveEvent.clientX, window.innerWidth);
      setSidebarWidth(latestWidth);
    };
    const finish = () => {
      document.body.classList.remove('resizing-sidebar');
      localStorage.setItem('coreading.sidebarWidth', String(latestWidth));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    document.body.classList.add('resizing-sidebar');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const resizeSidebarByKeyboard = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    setSidebarWidth((current) => event.key === 'Home'
      ? clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
      : clampSidebarWidth(current + (event.key === 'ArrowLeft' ? 24 : -24)));
  };

  const saveSelection = async () => {
    if (!selection || !composer) return;
    const endpoint = composer === 'discussion' ? 'discussions' : 'notes';
    const body = composer === 'discussion'
      ? { ...identity, roomId: roomId || null, message: comment || '我想讨论这段内容', quote: selection.text, locator: selection.locator }
      : { ...identity, roomId: roomId || null, text: selection.text, comment, locator: selection.locator, visibility: composer === 'room-note' ? 'room' : 'private', color: 'amber' };
    const response = await fetch(`${api}/books/${book.id}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) await loadSocial();
    setSelection(null); setComposer(null); setComment(''); window.getSelection()?.removeAllRanges();
  };

  const openImage = (image) => { setImageViewer(image); setImageZoom(1); };
  const actOnImage = (block, chapter, action) => {
    const label = block.caption || block.alt || '原书插图';
    setSelection({ kind: 'image', text: label, locator: publicationLocator(block, chapter) });
    setComposer(action);
    if (action === 'discussion') setSidebarOpen(true);
  };

  const chapters = documentData?.chapters || [];
  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeLocator?.chapterId));
  const activeChapter = chapters[activeChapterIndex];
  const epubChapterUrl = activeChapter?.href ? `${api}/books/${book.id}/epub-files/${activeChapter.href.split('/').map(encodeURIComponent).join('/')}` : '';
  useEffect(() => {
    if (mode !== 'standard' || !epubChapterUrl) { setEpubMarkup(''); return undefined; }
    let active = true;
    fetch(epubChapterUrl).then(async (response) => {
      if (!response.ok) throw new Error('EPUB chapter failed');
      const markup = await response.text();
      const absolute = new URL(epubChapterUrl, window.location.origin);
      const baseUrl = absolute.href.slice(0, absolute.href.lastIndexOf('/') + 1);
      const headInjection = `<base href="${baseUrl}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; object-src 'none'; script-src 'none'; form-action 'none';"><style>html,body{max-width:100%;overflow-x:hidden}body{margin:0 auto!important;padding:clamp(18px,5vw,56px)!important;box-sizing:border-box}img,svg,video,canvas{max-width:100%!important;height:auto!important;object-fit:contain}table{max-width:100%;display:block;overflow-x:auto}p,li,blockquote{overflow-wrap:anywhere}</style>`;
      const secured = /<head\b[^>]*>/i.test(markup) ? markup.replace(/<head\b[^>]*>/i, (head) => `${head}${headInjection}`) : `${headInjection}${markup}`;
      if (active) setEpubMarkup(secured);
    }).catch(() => active && setEpubMarkup('<!doctype html><meta charset="utf-8"><p>本章原书版面暂时无法加载，请切换到阅读模式。</p>'));
    return () => { active = false; };
  }, [epubChapterUrl, mode]);
  useEffect(() => {
    if (mode !== 'standard' || !activeLocator?.sourceAnchor) return;
    const revealAnchor = () => epubFrameRef.current?.contentDocument?.getElementById(activeLocator.sourceAnchor)?.scrollIntoView({ block: 'start' });
    const frame = epubFrameRef.current;
    frame?.addEventListener('load', revealAnchor, { once: true });
    requestAnimationFrame(revealAnchor);
    return () => frame?.removeEventListener('load', revealAnchor);
  }, [activeLocator?.sourceAnchor, epubChapterUrl, epubMarkup, mode]);
  const changeChapter = useCallback((delta, edge = 'start') => {
    const targetIndex = Math.max(0, Math.min(chapters.length - 1, activeChapterIndex + delta));
    if (targetIndex === activeChapterIndex || !chapters[targetIndex]?.blocks[0]) return false;
    const chapter = chapters[targetIndex];
    const targetBlock = edge === 'end' ? chapter.blocks.at(-1) : chapter.blocks[0];
    const locator = publicationLocator(targetBlock, chapter);
    setActiveLocator(locator);
    persistProgress(Math.round((targetIndex / Math.max(1, chapters.length)) * 100), locator);
    showNavHint(`${chapter.title} · ${targetIndex + 1}/${chapters.length} 章`);
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) {
        element.scrollTop = edge === 'end' ? Math.max(0, element.scrollHeight - element.clientHeight) : 0;
        updatePageInfo();
      }
      resolve(true);
    })));
  }, [activeChapterIndex, chapters, showNavHint, updatePageInfo]);

  const turnPage = useCallback(async (delta) => {
    if (turnBusy.current) return false;
    const element = scrollRef.current;
    if (!element) return false;
    turnBusy.current = true;
    showNavHint('正在翻页…');
    try {
      if (readingFlow === 'continuous') {
        const changed = await changeChapter(delta, delta < 0 ? 'end' : 'start');
        if (!changed) showNavHint(delta > 0 ? '已经是全书末尾' : '已经是全书开头');
        return Boolean(changed);
      }
      const step = Math.max(1, element.clientHeight);
      const total = Math.max(1, Math.ceil(element.scrollHeight / step));
      const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
      const current = maxScroll > 0 && element.scrollTop >= maxScroll - 2 ? total : Math.max(1, Math.min(total, Math.floor(element.scrollTop / step) + 1));
      if (delta > 0 && current < total) {
        await scrollToSettled(element, Math.min(maxScroll, current * step));
        showNavHint(`本章 ${current + 1}/${total} 页 · 全书 ${progress}%`);
        updatePageInfo();
        return true;
      }
      if (delta < 0 && current > 1) {
        await scrollToSettled(element, Math.max(0, (current - 2) * step));
        showNavHint(`本章 ${current - 1}/${total} 页 · 全书 ${progress}%`);
        updatePageInfo();
        return true;
      }
      const changed = await changeChapter(delta, delta < 0 ? 'end' : 'start');
      if (!changed) showNavHint(delta > 0 ? '已经是最后一页' : '已经是第一页');
      return Boolean(changed);
    } finally {
      turnBusy.current = false;
    }
  }, [changeChapter, progress, readingFlow, showNavHint, updatePageInfo]);

  const showBoundaryHint = useCallback((direction) => {
    const atBookEdge = direction > 0 ? activeChapterIndex === chapters.length - 1 : activeChapterIndex === 0;
    showNavHint(atBookEdge ? (direction > 0 ? '已经是全书末尾' : '已经是全书开头') : `再次滚动进入${direction > 0 ? '下一' : '上一'}章`);
  }, [activeChapterIndex, chapters.length, showNavHint]);

  const { handleWheel, handleTouchStart, handleTouchEnd } = useReadingInput({ scrollRef, readingFlow, turnPage, onBoundaryHint: showBoundaryHint, keyboardDisabled: mode !== 'reflow' || Boolean(composer || imageViewer || sidebarOpen) || readingFlow !== 'paged' });

  useEffect(() => {
    const timer = setTimeout(updatePageInfo, 80);
    return () => clearTimeout(timer);
  }, [activeChapterIndex, fontSize, lineHeight, readingFlow, updatePageInfo]);

  useEffect(() => {
    if (loading || mode !== 'reflow' || !scrollRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current;
      const anchor = layoutAnchor.current;
      const node = anchor?.blockId ? document.getElementById(anchor.blockId) : null;
      if (element && node) {
        const drift = node.getBoundingClientRect().top - anchor.top;
        if (Math.abs(drift) > 1) element.scrollTop += drift;
      }
      updatePageInfo();
    });
    observer.observe(scrollRef.current);
    if (scrollRef.current.firstElementChild) observer.observe(scrollRef.current.firstElementChild);
    return () => observer.disconnect();
  }, [activeChapterIndex, loading, mode, updatePageInfo]);

  const paneProps = {
    api,
    book,
    identity,
    toc,
    notes,
    discussions,
    rooms,
    roomId,
    setRoomId,
    activePane,
    setActivePane,
    activeLocator,
    selection: assistantSelection,
    onClearSelection: () => setAssistantSelection(null),
    sidebarWidth,
    onResizeStart: startSidebarResize,
    onResizeKeyDown: resizeSidebarByKeyboard,
    onResizeReset: () => setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH)),
    onJump: jumpTo,
    onReload: loadSocial,
    onClose: () => setSidebarOpen(false),
  };

  return (
    <div className={`reader-shell theme-${theme} ${sidebarOpen ? 'sidebar-visible' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` }}>
      <header className="reader-header">
        <button className="reader-back" onClick={onBack}><ArrowLeft size={18} /><span>书库</span></button>
        <div className="reader-title"><BookOpen size={17} /><span>{book.title}</span><small>{book.format}</small></div>
        <div className="reader-actions">
          {book.format === 'PDF' && <div className="mode-switch"><button className={mode === 'reflow' ? 'active' : ''} onClick={() => setMode('reflow')}>文本</button><button className={mode === 'original' ? 'active' : ''} onClick={() => setMode('original')}>原版</button></div>}
          {book.format === 'EPUB' && <div className="mode-switch" aria-label="EPUB 显示模式"><button className={mode === 'reflow' ? 'active' : ''} aria-pressed={mode === 'reflow'} onClick={() => setMode('reflow')}>阅读</button><button className={mode === 'standard' ? 'active' : ''} aria-pressed={mode === 'standard'} onClick={() => setMode('standard')}>原版</button></div>}
          <span className={`connection-dot ${connection}`} title={connection === 'online' ? '协作已连接' : '本地阅读'} />
          <button className="icon-button" title="阅读设置" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={18} /></button>
          <button className={`sidebar-toggle ${sidebarOpen ? 'active' : ''}`} onClick={() => setSidebarOpen((value) => !value)}><LayoutPanelLeft size={18} /><span>边栏</span></button>
        </div>
        {settingsOpen && <div className="reader-settings" role="dialog" aria-label="阅读设置"><div><span>翻页</span>{[['continuous', '连续'], ['paged', '分页']].map(([value, label]) => <button key={value} aria-pressed={readingFlow === value} className={readingFlow === value ? 'active' : ''} onClick={() => setReadingFlow(value)}>{label}</button>)}</div><div><span>字号</span><button aria-label="减小字号" onClick={() => setFontSize(Math.max(14, fontSize - 1))}><Minus size={14} /></button><strong>{fontSize}</strong><button aria-label="增大字号" onClick={() => setFontSize(Math.min(38, fontSize + 1))}><Plus size={14} /></button></div><div><span>行距</span>{[1.55, 1.85, 2.15].map((value) => <button key={value} aria-pressed={lineHeight === value} className={lineHeight === value ? 'active' : ''} onClick={() => setLineHeight(value)}>{value}</button>)}</div><div><span>纸张</span>{[['paper', '米白'], ['white', '白'], ['night', '夜']].map(([value, label]) => <button key={value} aria-pressed={theme === value} className={theme === value ? 'active' : ''} onClick={() => setTheme(value)}>{label}</button>)}</div></div>}
      </header>

      <div className="reading-progress" aria-label={`阅读进度 ${progress}%`}><i style={{ width: `${progress}%` }} /></div>
      <main className="reader-stage" aria-busy={loading}>
        {loading && <div className="reader-status"><RefreshCw className="spin" /><h2>正在准备正文</h2><p>首次打开会建立本地章节索引。</p></div>}
        {error && <div className="reader-status error"><h2>这本书暂时无法打开</h2><p>{error}</p><div><button onClick={load}>重新解析</button><button onClick={onBack}>返回书库</button></div></div>}
        {!loading && !error && mode === 'original' && <iframe className="pdf-frame" title={`${book.title} 原始版面`} src={`${api}/books/${book.id}/content#page=${activeLocator?.page || 1}`} />}
        {!loading && !error && mode === 'standard' && epubChapterUrl && <><div className="original-mode-notice" role="note"><span><strong>原版对照</strong>用于查看原书排版、表格和图片；划线与笔记请使用阅读模式。</span><button onClick={() => setMode('reflow')}>回到阅读模式</button></div><iframe ref={epubFrameRef} key={epubChapterUrl} className="epub-frame" sandbox="allow-same-origin" title={`${book.title} · ${activeChapter?.title || '原版页面'}`} srcDoc={epubMarkup} /></>}
        {!loading && !error && mode === 'reflow' && (
          <div ref={scrollRef} className={`reflow-scroll flow-${readingFlow}`} onScroll={onScroll} onWheel={handleWheel} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onMouseUp={handleSelection}>
            <article className="reading-column" style={{ fontSize: `${fontSize}px`, lineHeight }}>
              {chapters[activeChapterIndex] && [chapters[activeChapterIndex]].map((chapter) => <section className="book-chapter" key={chapter.id}><h1>{chapter.title}</h1>{chapter.isImageScan && <div className="scan-callout">这是扫描版 PDF，请切换到“原版”阅读。</div>}{chapter.blocks.map((block) => {
                if (block.type === 'image') return <ImageBlock key={block.id} api={api} book={book} block={block} chapter={chapter} onOpen={openImage} onAction={actOnImage} />;
                const Tag = block.type === 'heading' ? `h${Math.min(4, block.level || 2)}` : block.type === 'blockquote' ? 'blockquote' : 'p';
                return <Tag key={block.id} id={block.id} data-block-id={block.id} data-chapter-id={chapter.id} data-page={block.page || chapter.page || ''}><HighlightedText block={block} notes={notes} /></Tag>;
              })}{book.format === 'PDF' && chapter.page && <PdfPageImages api={api} book={book} chapter={chapter} onOpen={openImage} onAction={actOnImage} />}</section>)}
              {activeChapterIndex === chapters.length - 1 && <footer className="end-of-book"><CheckCircleIcon /> <strong>读到这里，已经是全书末尾</strong><span>你的进度和笔记已保存在本机。</span></footer>}
            </article>
          </div>
        )}
        {!loading && !error && mode === 'reflow' && <>{navHint && <div className="page-turn-hint" role="status" aria-live="polite">{navHint}</div>}<nav className={`chapter-nav flow-nav-${readingFlow}`} aria-label="阅读导航"><button disabled={activeChapterIndex === 0 && (readingFlow === 'continuous' || pageInfo.current === 1)} onClick={() => turnPage(-1)}><ChevronLeft /> 上一{readingFlow === 'paged' ? '页' : '章'}</button><span>{readingFlow === 'paged' ? `${pageInfo.current}/${pageInfo.total} · ${progress}%` : `${activeChapterIndex + 1}/${chapters.length} 章 · ${progress}%`}</span><button disabled={activeChapterIndex === chapters.length - 1 && (readingFlow === 'continuous' || pageInfo.current === pageInfo.total)} onClick={() => turnPage(1)}>下一{readingFlow === 'paged' ? '页' : '章'} <ChevronRight /></button></nav></>}
        {!loading && !error && mode === 'standard' && <nav className="chapter-nav" aria-label="原书章节导航"><button disabled={activeChapterIndex === 0} onClick={() => changeChapter(-1)}><ChevronLeft /> 上一章</button><span>{activeChapterIndex + 1}/{chapters.length} 章</span><button disabled={activeChapterIndex === chapters.length - 1} onClick={() => changeChapter(1)}>下一章 <ChevronRight /></button></nav>}
      </main>

      {sidebarOpen && <CollaborationPane {...paneProps} />}
      {selection && !composer && <div className="selection-toolbar"><span>{selection.kind === 'image' ? '已选图片' : `已选 ${selection.text.length} 字`}</span>{selection.kind !== 'image' && <button className="ask-selection" onClick={askSelection}><Bot size={15} /> 问阅读伙伴</button>}<button onClick={() => setComposer('private-note')}><Highlighter size={15} /> {selection.kind === 'image' ? '收藏图片' : '私人划线'}</button><button onClick={() => setComposer(roomId ? 'room-note' : 'private-note')}><MessageCircle size={15} /> {roomId ? '共读划线' : '写笔记'}</button><button onClick={() => { setComposer('discussion'); setSidebarOpen(true); }}><MessageCircle size={15} /> 发起讨论</button><button aria-label="取消" onClick={() => setSelection(null)}><X size={15} /></button></div>}
      {composer && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setComposer(null)}><div className="composer-modal"><button className="modal-close" onClick={() => setComposer(null)}><X /></button><p className="eyebrow">{composer === 'discussion' ? '基于原文发起讨论' : composer === 'room-note' ? '小组可见划线' : '仅自己可见'}</p><blockquote>{selection?.text}</blockquote><textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} placeholder={composer === 'discussion' ? '你想和大家讨论什么？' : '写下此刻的想法（可选）'} /><button className="primary-action" onClick={saveSelection}>保存</button></div></div>}
      {imageViewer && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={imageViewer.alt || '查看原书插图'} onMouseDown={(event) => event.target === event.currentTarget && setImageViewer(null)}><div className="lightbox-toolbar"><span>{imageViewer.caption || imageViewer.alt || '原书插图'}</span><button onClick={() => setImageZoom((value) => Math.max(.5, value - .25))} title="缩小"><ZoomOut /></button><strong>{Math.round(imageZoom * 100)}%</strong><button onClick={() => setImageZoom((value) => Math.min(4, value + .25))} title="放大"><ZoomIn /></button><button onClick={() => setImageViewer(null)} title="关闭"><X /></button></div><div className="lightbox-canvas"><img src={imageViewer.source} alt={imageViewer.alt || '原书插图'} style={{ transform: `scale(${imageZoom})` }} /></div></div>}
    </div>
  );
}

function CheckCircleIcon() { return <span className="finish-icon">✓</span>; }
