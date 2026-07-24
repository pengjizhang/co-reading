import React, { useEffect, useState } from 'react';
import { Bookmark, Image as ImageIcon, Maximize2, MessageCircle, RefreshCw } from 'lucide-react';

export function ImageBlock({ api, book, block, chapter, onOpen, onAction }) {
  const [failed, setFailed] = useState(false);
  const source = `${api}/books/${book.id}/assets/${encodeURIComponent(block.assetId)}`;
  return (
    <figure id={block.id} className="reader-figure" data-block-id={block.id} data-chapter-id={chapter.id} data-page={block.page || chapter.page || ''}>
      <button className="figure-image-button" onClick={() => !failed && onOpen({ ...block, source })} aria-label={`查看大图：${block.alt || '原书插图'}`}>
        {!failed ? <img src={source} alt={block.alt || '原书插图'} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span className="image-placeholder"><ImageIcon /><strong>图片暂时无法显示</strong><small>原书资源可能损坏，PDF 可切换“原版”查看。</small></span>}
      </button>
      <figcaption><span>{block.caption || block.alt || '原书插图'}</span><span className="figure-actions"><button onClick={() => onOpen({ ...block, source })} disabled={failed} aria-label="查看大图" title="查看大图"><Maximize2 /></button><button onClick={() => onAction(block, chapter, 'private-note')} aria-label="收藏图片" title="收藏图片"><Bookmark /></button><button onClick={() => onAction(block, chapter, 'discussion')} aria-label="讨论图片" title="讨论图片"><MessageCircle /></button></span></figcaption>
    </figure>
  );
}

export function PdfPageImages({ api, book, chapter, onOpen, onAction }) {
  const [images, setImages] = useState([]);
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    let active = true;
    setStatus('loading'); setImages([]);
    fetch(`${api}/books/${book.id}/pages/${chapter.page}/images`).then(async (response) => {
      if (!response.ok) throw new Error('extract failed');
      const payload = await response.json();
      if (active) { setImages(payload.images || []); setStatus('ready'); }
    }).catch(() => active && setStatus('error'));
    return () => { active = false; };
  }, [api, book.id, chapter.page]);
  if (status === 'loading') return <div className="page-images-status"><RefreshCw className="spin" /> 正在恢复本页原书插图…</div>;
  if (status === 'error') return <div className="page-images-status muted">本页图片未能单独提取，可切换“原版”完整查看。</div>;
  if (!images.length) return null;
  return <aside className="pdf-page-images"><p><ImageIcon /> 本页原书插图 · {images.length}</p>{images.map((block) => <ImageBlock key={block.id} api={api} book={book} block={block} chapter={chapter} onOpen={onOpen} onAction={onAction} />)}</aside>;
}
