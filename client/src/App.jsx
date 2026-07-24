import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Library as LibraryIcon, RotateCcw } from 'lucide-react';
import Library from './components/Library';
import Reader from './components/Reader';

const API = '/api';

export default function App() {
  const [userId] = useState(() => {
    const saved = localStorage.getItem('coreading.userId');
    if (saved) return saved;
    const value = crypto.randomUUID();
    localStorage.setItem('coreading.userId', value);
    return value;
  });
  const [userName, setUserName] = useState(() => localStorage.getItem('coreading.userName') || '我');
  const [activeBook, setActiveBook] = useState(null);
  const [connection, setConnection] = useState('offline');
  const socketRef = useRef(null);

  useEffect(() => {
    if (!activeBook) return undefined;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.hostname === 'localhost' ? `${location.hostname}:3030` : location.host;
    const socket = new WebSocket(`${protocol}//${host}`);
    socketRef.current = socket;
    socket.onopen = () => {
      setConnection('online');
      socket.send(JSON.stringify({ type: 'subscribe', bookId: activeBook.id, userId, userName }));
    };
    socket.onclose = () => setConnection('offline');
    return () => socket.close();
  }, [activeBook, userId, userName]);

  const identity = useMemo(() => ({ userId, userName }), [userId, userName]);
  const rename = (name) => {
    const value = name.trim() || '我';
    setUserName(value);
    localStorage.setItem('coreading.userName', value);
  };

  if (activeBook) {
    return <Reader api={API} book={activeBook} identity={identity} ws={socketRef.current} connection={connection} onBack={() => setActiveBook(null)} />;
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <button className="brand" type="button" aria-label="返回书库">
          <span className="brand-mark"><BookOpen size={20} /></span>
          <span><strong>同读</strong><small>本地阅读空间</small></span>
        </button>
        <div className="header-meta">
          <span className="local-badge"><RotateCcw size={13} /> 本地优先</span>
          <label className="profile-chip">
            <span>{userName.slice(0, 1)}</span>
            <input aria-label="阅读者昵称" value={userName} onChange={(event) => rename(event.target.value)} />
          </label>
        </div>
      </header>
      <Library api={API} identity={identity} onSelectBook={setActiveBook} />
    </div>
  );
}
