import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookMarked, Bot, CheckCircle2, ChevronDown, ChevronRight, Copy, Cpu, Highlighter, ListTree, MessageCircle, Plus, Search, Send, Square, Trash2, Users, Wifi, WifiOff, X } from 'lucide-react';
import { buildSelectionAskPayload, SELECTION_QUICK_QUESTIONS, selectionKey } from '../lib/selectionAsk';

const tabs = [
  ['toc', '目录', ListTree],
  ['notes', '笔记', Highlighter],
  ['discuss', '共读', MessageCircle],
  ['search', '搜索', Search],
  ['assistant', '问书', Bot]
];

export default function CollaborationPane({ api, book, identity, toc, notes, discussions, rooms, roomId, setRoomId, activePane, setActivePane, activeLocator, selection, onClearSelection, sidebarWidth, onResizeStart, onResizeKeyDown, onResizeReset, onJump, onReload, onClose }) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const [answerMode, setAnswerMode] = useState('quick');
  const [useCurrentLocation, setUseCurrentLocation] = useState(true);
  const [aiCapabilities, setAiCapabilities] = useState(null);
  const [roomForm, setRoomForm] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [replyText, setReplyText] = useState({});
  const askController = useRef(null);
  const questionInput = useRef(null);
  const currentRoom = rooms.find((room) => room.id === roomId);
  const attachedSelectionKey = selectionKey(selection);

  const loadAICapabilities = async (probe = false) => {
    try {
      const response = await fetch(`${api}/ai/capabilities${probe ? '?probe=1' : ''}`);
      const payload = await response.json();
      setAiCapabilities(payload);
    } catch {
      setAiCapabilities((current) => current || { workagent: { enabled: true, online: false, lastError: '状态检测失败' } });
    }
  };

  useEffect(() => {
    if (activePane === 'assistant') loadAICapabilities(true);
  }, [activePane, api]);
  useEffect(() => () => askController.current?.abort(), []);
  useEffect(() => {
    if (!attachedSelectionKey) return undefined;
    setQuestion('');
    setAnswer(null);
    setAskError('');
    const timer = setTimeout(() => questionInput.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [attachedSelectionKey]);

  const searchBook = async (event) => {
    event.preventDefault(); if (!query.trim()) return;
    setSearching(true);
    const response = await fetch(`${api}/books/${book.id}/search?q=${encodeURIComponent(query.trim())}`);
    if (response.ok) setSearchResults(await response.json());
    setSearching(false);
  };

  const askBook = async (event) => {
    event.preventDefault();
    const requestPayload = buildSelectionAskPayload({
      question,
      selection,
      book,
      mode: answerMode,
      useCurrentLocation,
      activeLocator,
      userId: identity.userId,
    });
    if (!requestPayload.question) return;
    setAsking(true); setAnswer(null); setAskError('');
    askController.current?.abort();
    const controller = new AbortController();
    askController.current = controller;
    try {
      const response = await fetch(`${api}/books/${book.id}/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '问书服务暂时不可用');
      setAnswer(payload);
    } catch (error) {
      setAskError(error.name === 'AbortError' ? '已取消本次回答。' : error.message);
    } finally {
      if (askController.current === controller) {
        askController.current = null;
        setAsking(false);
        loadAICapabilities();
      }
    }
  };

  const cancelAsk = () => askController.current?.abort();

  const createRoom = async () => {
    const response = await fetch(`${api}/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: book.id, name: roomName || `${book.title} 共读`, ...identity }) });
    if (response.ok) { const room = await response.json(); setRoomId(room.id); setRoomForm(false); setRoomName(''); await onReload(); }
  };

  const joinRoom = async () => {
    const response = await fetch(`${api}/rooms/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode, ...identity }) });
    if (response.ok) { const room = await response.json(); setRoomId(room.id); setRoomForm(false); setInviteCode(''); await onReload(); }
  };

  const deleteNote = async (noteId) => { await fetch(`${api}/books/${book.id}/notes/${noteId}`, { method: 'DELETE' }); await onReload(); };
  const reply = async (discussionId) => {
    const message = replyText[discussionId]?.trim(); if (!message) return;
    await fetch(`${api}/books/${book.id}/discussions/${discussionId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, ...identity }) });
    setReplyText((value) => ({ ...value, [discussionId]: '' })); await onReload();
  };

  return (
    <aside className="reading-sidebar" aria-label="阅读边栏">
      <div className="sidebar-resizer" role="separator" aria-label="调整阅读边栏宽度" aria-orientation="vertical" aria-valuemin="300" aria-valuemax="720" aria-valuenow={sidebarWidth} tabIndex="0" onPointerDown={onResizeStart} onKeyDown={onResizeKeyDown} onDoubleClick={onResizeReset}><span /></div>
      <div className="sidebar-head"><div className="sidebar-tabs">{tabs.map(([value, label, Icon]) => <button key={value} className={activePane === value ? 'active' : ''} onClick={() => setActivePane(value)} title={label}><Icon size={17} /><span>{label}</span></button>)}</div><button className="close-sidebar" aria-label="关闭边栏" onClick={onClose}><X size={18} /></button></div>
      <div className="sidebar-body">
        {activePane === 'toc' && <section className="pane-section"><PaneTitle title="目录" detail={`${toc.length} 个目录节点`} />{toc.length ? <TocTree toc={toc} activeLocator={activeLocator} onJump={onJump} /> : <Empty icon={ListTree} title="没有识别到目录" text="仍可通过正文滚动阅读。" />}</section>}

        {activePane === 'notes' && <section className="pane-section"><PaneTitle title="划线与笔记" detail={`${notes.length} 条`} />{notes.length ? <div className="note-list">{notes.map((note) => <article className="note-card" key={note.id}><button className="note-main" onClick={() => onJump(note.locator)}><span className={`visibility-tag ${note.visibility}`}>{note.visibility === 'room' ? '共读' : '私人'}</span><blockquote>{note.text}</blockquote>{note.comment && <p>{note.comment}</p>}<small>{note.userName} · {new Date(note.createdAt).toLocaleDateString()}</small></button>{note.userId === identity.userId && <button className="delete-note" onClick={() => deleteNote(note.id)} title="删除"><Trash2 size={14} /></button>}</article>)}</div> : <Empty icon={Highlighter} title="还没有划线" text="在正文中选择文字，即可留下私人或共读笔记。" />}</section>}

        {activePane === 'discuss' && <section className="pane-section"><div className="room-selector"><div><span>当前空间</span><select value={roomId} onChange={(event) => setRoomId(event.target.value)}><option value="">私人阅读</option>{rooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}</select></div><button onClick={() => setRoomForm((value) => !value)}><Plus size={16} /> 小组</button></div>{roomForm && <div className="room-form"><label>创建共读小组<input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder={`${book.title} 共读`} /></label><button onClick={createRoom}>创建</button><i>或</i><label>使用邀请码加入<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="8 位邀请码" /></label><button onClick={joinRoom}>加入</button></div>}{currentRoom && <div className="room-summary"><div><Users size={17} /><strong>{currentRoom.members.length} 位成员</strong></div><button onClick={() => navigator.clipboard?.writeText(currentRoom.inviteCode)} title="复制邀请码"><Copy size={14} /> {currentRoom.inviteCode}</button></div>}<PaneTitle title={roomId ? '原文讨论' : '讨论预览'} detail={roomId ? `${discussions.length} 个话题` : '加入小组后可发起讨论'} />{discussions.length ? <div className="discussion-list">{discussions.map((item) => <article className="discussion-card" key={item.id}><button className="discussion-quote" onClick={() => onJump(item.locator)}>“{item.quote || item.locator?.textQuote}”</button><div className="discussion-message"><strong>{item.userName}</strong><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleString()}</small></div>{item.replies.map((replyItem) => <div className="discussion-reply" key={replyItem.id}><strong>{replyItem.userName}</strong><span>{replyItem.message}</span></div>)}{roomId && <div className="reply-box"><input value={replyText[item.id] || ''} onChange={(event) => setReplyText((value) => ({ ...value, [item.id]: event.target.value }))} placeholder="回复这个想法" onKeyDown={(event) => event.key === 'Enter' && reply(item.id)} /><button onClick={() => reply(item.id)}><Send size={14} /></button></div>}</article>)}</div> : <Empty icon={MessageCircle} title="暂无原文讨论" text={roomId ? '在正文中选中文字并点击“发起讨论”。' : '私人阅读不展示群组讨论。'} />}</section>}

        {activePane === 'search' && <section className="pane-section"><PaneTitle title="书内搜索" detail="定位到原文" /><form className="pane-search" onSubmit={searchBook}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入人物、概念或原句" /><button disabled={searching}>{searching ? '…' : '搜索'}</button></form>{searchResults.length ? <div className="result-list"><p>找到 {searchResults.length} 处</p>{searchResults.map((result, index) => <button key={`${result.locator.blockId}-${index}`} onClick={() => onJump(result.locator)}><strong>{result.chapterTitle}</strong><span>{result.text}</span><ChevronRight size={15} /></button>)}</div> : <Empty icon={Search} title="从整本书中找原文" text="搜索结果会保留上下文，并可直接跳转。" />}</section>}

        {activePane === 'assistant' && <section className="pane-section assistant-pane">
          <PaneTitle title="WorkAgent 阅读伙伴" detail="原书取证 · 扩展理解" />
          <AgentStatus capabilities={aiCapabilities} />
          <div className="grounded-notice"><BookMarked size={17} /><span>co-reading 负责原文和定位，WorkAgent 负责分析；回答按 WorkAgent 内容呈现，并把 E 编号关联到原文。</span></div>
          {selection?.text && <div className="selection-attachment">
            <div><BookMarked size={15} /><strong>已引用原文</strong><span>{selection.chapterTitle || '当前章节'}</span></div>
            <blockquote>{selection.text}</blockquote>
            <div className="selection-attachment-actions">
              <button type="button" onClick={() => selection.locator && onJump(selection.locator)}>定位原文</button>
              <button type="button" onClick={onClearSelection}>移除引用</button>
            </div>
          </div>}
          <form className="assistant-form" onSubmit={askBook}>
            <div className="answer-mode" role="group" aria-label="回答深度">
              <button type="button" className={answerMode === 'quick' ? 'active' : ''} onClick={() => setAnswerMode('quick')}><strong>快速回答</strong><span>重点证据，响应更快</span></button>
              <button type="button" className={answerMode === 'deep' ? 'active' : ''} onClick={() => setAnswerMode('deep')}><strong>深入理解</strong><span>跨章节综合，说明关系与边界</span></button>
            </div>
            <label className="context-option"><input type="checkbox" checked={useCurrentLocation} onChange={(event) => setUseCurrentLocation(event.target.checked)} />优先参考当前阅读章节</label>
            {selection?.text && <div className="selection-quick-questions" aria-label="快捷问题">{SELECTION_QUICK_QUESTIONS.map((item) => <button type="button" key={item} onClick={() => { setQuestion(item); questionInput.current?.focus(); }}>{item}</button>)}</div>}
            <textarea ref={questionInput} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={selection?.text ? '可选：你对这段内容有什么具体疑问？' : '例如：作者如何解释 OTN 的关键技术演进？'} />
            <div className="assistant-actions">
              <button className="primary-action" disabled={asking || (!question.trim() && !selection?.text)}>{asking ? (answerMode === 'deep' ? 'WorkAgent 正在深入分析…' : '正在组织书内证据…') : !question.trim() && selection?.text ? '解释选中内容' : '向阅读伙伴提问'}</button>
              {asking && <button type="button" className="cancel-answer" onClick={cancelAsk}><Square size={12} />取消</button>}
            </div>
          </form>
          {askError && <div className="assistant-error"><AlertCircle size={15} />{askError}</div>}
          {answer && <div className={`assistant-answer ${answer.refused ? 'refused' : ''}`}>
            <div className="answer-status">
              {answer.refused ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
              <span>{answer.refused
                ? '证据不足，已停止推断'
                : answer.provider?.startsWith('workagent:')
                  ? `WorkAgent 已返回 · 已关联 ${answer.sources?.length || 0} 条书内证据`
                  : `已核对 ${answer.sources?.length || 0} 条书内证据`}</span>
              <small>{providerLabel(answer.provider)} · {answer.diagnostics?.elapsedMs || 0}ms</small>
            </div>
            {answer.fallback && <div className="fallback-notice">WorkAgent 未完成本次回答，已自动降级到 {providerLabel(answer.provider)}。</div>}
            {answer.provider?.startsWith('workagent:') && answer.verification?.valid === false && <div className="verification-notice">部分主张未能关联到本次检索出的本地证据，以下内容仍按 WorkAgent 返回结果完整展示。</div>}
            <AnswerSection title={answer.provider?.startsWith('workagent:') ? 'WorkAgent 回答' : '原书结论'} text={answer.answer} />
            <ClaimList claims={answer.claims} sources={answer.sources} onJump={onJump} />
            <UnderstandingSections understanding={answer.understanding} setQuestion={setQuestion} />
            {answer.providerNotice && <div className="provider-notice">{answer.providerNotice}</div>}
            {Boolean(answer.sources?.length) && <div className="source-list"><h3>原文依据</h3>{answer.sources.map((source, index) => <button key={`${source.id}-${source.bookId}-${source.blockId}`} onClick={() => source.locator && onJump(source.locator)} disabled={!source.locator}><small>证据 {source.id || index + 1} · {source.bookTitle ? `《${source.bookTitle}》/ ` : ''}{source.chapterTitle}</small><span>{source.excerpt}</span><i>查看原文 <ChevronRight size={13} /></i></button>)}</div>}
          </div>}
        </section>}
      </div>
    </aside>
  );
}

function TocTree({ toc, activeLocator, onJump }) {
  const childrenByParent = useMemo(() => {
    const map = new Map();
    toc.forEach((item) => {
      const key = item.parentId || 'root';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return map;
  }, [toc]);
  const itemById = useMemo(() => new Map(toc.map((item) => [item.id, item])), [toc]);
  const activeItem = useMemo(() => {
    const exact = toc.find((item) => item.locator && (item.locator.sourceAnchor && item.locator.sourceAnchor === activeLocator?.sourceAnchor));
    if (exact) return exact;
    const candidates = toc.filter((item) => item.locator?.chapterId === activeLocator?.chapterId && Number(item.locator?.sourceOrdinal) <= Number(activeLocator?.sourceOrdinal ?? -1));
    return candidates.sort((a, b) => Number(b.locator.sourceOrdinal) - Number(a.locator.sourceOrdinal) || b.level - a.level)[0] || null;
  }, [activeLocator, toc]);
  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => {
    if (!activeItem) return;
    setExpanded((current) => {
      const next = new Set(current); let parentId = activeItem.parentId;
      while (parentId) { next.add(parentId); parentId = itemById.get(parentId)?.parentId; }
      return next;
    });
  }, [activeItem, itemById]);
  const visible = toc.filter((item) => {
    let parentId = item.parentId;
    while (parentId) { if (!expanded.has(parentId)) return false; parentId = itemById.get(parentId)?.parentId; }
    return true;
  });
  const toggle = (id) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const expandableIds = [...childrenByParent.keys()].filter((id) => id !== 'root');
  return <div className="toc-tree">
    <div className="toc-tools"><button onClick={() => setExpanded(new Set(expandableIds))}>展开全部</button><button onClick={() => setExpanded(new Set())}>折叠全部</button></div>
    <div className="toc-items">{visible.map((item) => {
      const hasChildren = childrenByParent.has(item.id);
      return <div className={`toc-row ${activeItem?.id === item.id ? 'active' : ''}`} style={{ paddingLeft: `${4 + item.level * 14}px` }} key={item.id}>
        {hasChildren ? <button className="toc-toggle" aria-label={`${expanded.has(item.id) ? '折叠' : '展开'} ${item.title}`} aria-expanded={expanded.has(item.id)} onClick={() => toggle(item.id)}>{expanded.has(item.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="toc-spacer" />}
        <button className="toc-link" disabled={!item.locator} onClick={() => item.locator && onJump(item.locator)}><span>{item.title}</span>{item.locator?.page && <small>{item.locator.page}</small>}</button>
      </div>;
    })}</div>
  </div>;
}

function PaneTitle({ title, detail }) { return <div className="pane-title"><h2>{title}</h2><span>{detail}</span></div>; }
function Empty({ icon: Icon, title, text }) { return <div className="pane-empty"><Icon size={28} /><strong>{title}</strong><p>{text}</p></div>; }

function providerLabel(provider = '') {
  if (provider.startsWith('workagent:')) return `WorkAgent · ${provider.slice('workagent:'.length).replace(/^deepseek:/, '')}`;
  if (provider.startsWith('deepseek:')) return `DeepSeek · ${provider.slice('deepseek:'.length)}`;
  return provider === 'local-extractive' ? '本地证据整理' : provider || '未知服务';
}

function AgentStatus({ capabilities }) {
  const agent = capabilities?.workagent;
  const checking = !capabilities || agent?.online === null || agent?.online === undefined;
  const online = agent?.enabled && agent?.online === true;
  const Icon = checking ? Cpu : online ? Wifi : WifiOff;
  const label = checking ? '正在检测 WorkAgent' : online ? 'WorkAgent 在线' : agent?.enabled ? 'WorkAgent 离线，问书将自动降级' : 'WorkAgent 未启用';
  const model = agent?.deepModel?.replace(/^deepseek:/, '') || agent?.quickModel?.replace(/^deepseek:/, '');
  return <div className={`agent-status ${online ? 'online' : checking ? 'checking' : 'offline'}`} title={agent?.lastError || ''}><Icon size={14} /><span>{label}</span>{online && model && <small>{model}</small>}</div>;
}

function AnswerSection({ title, text }) {
  if (!text) return null;
  return <section className="understanding-section book-conclusion"><h3>{title}</h3><p>{text}</p></section>;
}

function ClaimList({ claims, sources, onJump }) {
  if (!claims?.length) return null;
  const sourceById = new Map((sources || []).map((source) => [source.id, source]));
  return <section className="understanding-section claim-list">
    <h3>主张与证据</h3>
    {claims.map((claim, index) => {
      const evidenceIds = claim.evidenceIds?.length ? claim.evidenceIds : claim.citationIds || [];
      return <article key={claim.id || `${claim.text}-${index}`}>
        <p>{claim.text}</p>
        <div>{evidenceIds.length ? evidenceIds.map((id) => {
          const source = sourceById.get(id);
          return <button type="button" key={id} disabled={!source?.locator} onClick={() => source?.locator && onJump(source.locator)} title={source ? `查看《${source.bookTitle || ''}》${source.chapterTitle || ''}` : '本次上下文未找到对应证据'}>{id}</button>;
        }) : <span>未提供证据编号</span>}</div>
      </article>;
    })}
  </section>;
}

function UnderstandingSections({ understanding, setQuestion }) {
  if (!understanding) return null;
  return <>
    {understanding.expanded && <section className="understanding-section expanded"><h3>WorkAgent 扩展理解</h3><p>{understanding.expanded}</p></section>}
    {(understanding.external || understanding.externalSources?.length) && <section className="understanding-section external"><h3>外部扩展</h3>{understanding.external && <p>{understanding.external}</p>}{Boolean(understanding.externalSources?.length) && <ul>{understanding.externalSources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{source.quote && <span>{source.quote}</span>}</li>)}</ul>}</section>}
    {Boolean(understanding.limitations?.length) && <section className="understanding-section limitations"><h3>局限说明</h3><ul>{understanding.limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section>}
    {Boolean(understanding.followUpQuestions?.length) && <section className="understanding-section follow-ups"><h3>继续追问</h3>{understanding.followUpQuestions.map((item) => <button type="button" key={item} onClick={() => setQuestion(item)}>{item}<ChevronRight size={12} /></button>)}</section>}
  </>;
}
