'use client';

/* eslint-disable @next/next/no-img-element -- covers are served by the local Kanbox sidecar */

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, Check, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import type { Note } from '../types/xiaohongshu';
import { dailyReviewKey, selectDailyReviewNotes } from '../lib/daily-review.mjs';

type DailyReviewDialogProps = {
  notes: Note[];
  onClose: () => void;
  onOpenNote: (note: Note) => void;
};

function excerpt(note: Note): string {
  return String(note.aiSummary || note.rawContent || note.content || note.transcriptText || '打开笔记，重新看看当时收藏的内容。')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function DailyReviewDialog({ notes, onClose, onOpenNote }: DailyReviewDialogProps) {
  const reviewNotes = useMemo(() => selectDailyReviewNotes(notes, { count: 5 }) as Note[], [notes]);
  const storageKey = `kanbox:daily-review:${dailyReviewKey()}`;
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const firstPending = Math.max(0, reviewNotes.findIndex((note) => !reviewedIds.has(note.id)));
  const [index, setIndex] = useState(firstPending);
  const current = reviewNotes[index];
  const completed = reviewNotes.length > 0 && reviewNotes.every((note) => reviewedIds.has(note.id));

  const saveReviewed = (next: Set<string>) => {
    setReviewedIds(next);
    window.localStorage.setItem(storageKey, JSON.stringify([...next]));
  };

  const markCurrentReviewed = () => {
    if (!current) return;
    const next = new Set(reviewedIds);
    next.add(current.id);
    saveReviewed(next);
    if (index < reviewNotes.length - 1) setIndex(index + 1);
  };

  const resetToday = () => {
    saveReviewed(new Set());
    setIndex(0);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 340, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 28, background: 'rgba(57, 52, 45, 0.28)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(760px, calc(100vw - 48px))', minHeight: 520, overflow: 'hidden',
          borderRadius: 28, background: '#FDFCFA', border: '1px solid rgba(255,255,255,0.8)',
          boxShadow: '0 38px 110px rgba(73,56,28,0.24)', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(73,56,28,0.07)' }}>
          <div>
            <div style={{ fontSize: 11, color: '#829987', fontWeight: 700, letterSpacing: '0.12em' }}>DAILY REVIEW</div>
            <h2 style={{ margin: '4px 0 0', fontFamily: '"Playfair Display", Georgia, serif', fontSize: 23, color: '#3A3840' }}>每日回顾</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 11, color: '#928D85' }}>{reviewedIds.size}/{reviewNotes.length} 已回顾</span>
            <button type="button" onClick={onClose} aria-label="关闭每日回顾" style={{ width: 34, height: 34, borderRadius: 999, border: '1px solid rgba(73,56,28,0.08)', background: '#F3F0EA', color: '#6F6B64', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={15} /></button>
          </div>
        </div>

        {reviewNotes.length === 0 ? (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#8C877F', textAlign: 'center', padding: 40 }}>
            <div><BookOpen size={34} color="#829987" style={{ margin: '0 auto 14px' }} /><div style={{ fontSize: 18, color: '#4B494F' }}>收藏一些内容后再来回顾吧</div></div>
          </div>
        ) : completed ? (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 40 }}>
            <div>
              <div style={{ width: 62, height: 62, borderRadius: 999, display: 'grid', placeItems: 'center', margin: '0 auto 18px', background: 'rgba(130,153,135,0.15)', color: '#5D7663' }}><Check size={27} /></div>
              <div style={{ fontFamily: '"Playfair Display", Georgia, serif', fontSize: 24, color: '#3A3840' }}>今天的回顾完成了</div>
              <p style={{ fontSize: 12, color: '#928D85', margin: '10px 0 20px' }}>明天会为你换一组旧收藏。</p>
              <button type="button" onClick={resetToday} style={{ height: 36, padding: '0 15px', borderRadius: 14, border: '1px solid rgba(73,56,28,0.09)', background: '#F3F0EA', color: '#68635C', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}><RefreshCw size={13} />再看一遍</button>
            </div>
          </div>
        ) : current ? (
          <AnimatePresence mode="wait">
            <motion.div key={current.id} initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(230px, 42%) 1fr', minHeight: 430 }}>
              <div style={{ margin: 22, borderRadius: 20, overflow: 'hidden', background: '#E8E4DC', minHeight: 340 }}>
                {current.coverUrl ? <img src={current.coverUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#829987' }}><BookOpen size={36} /></div>}
              </div>
              <div style={{ padding: '34px 28px 28px 8px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: '#928D85' }}><span style={{ padding: '4px 9px', borderRadius: 999, background: 'rgba(130,153,135,0.12)', color: '#5D7663' }}>{current.category || '未分类'}</span><span>第 {index + 1} / {reviewNotes.length} 条</span></div>
                <h3 style={{ margin: '18px 0 12px', fontFamily: '"Playfair Display", Georgia, serif', fontSize: 25, lineHeight: 1.32, color: '#3A3840' }}>{current.title || '未命名笔记'}</h3>
                <p style={{ margin: 0, color: '#777169', fontSize: 13, lineHeight: 1.8, display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{excerpt(current)}</p>
                <div style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 9 }}>
                  <button type="button" onClick={() => onOpenNote(current)} style={{ height: 38, padding: '0 15px', borderRadius: 14, border: '1px solid rgba(73,56,28,0.08)', background: '#F2EFE9', color: '#625E57', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}><BookOpen size={14} />打开阅读</button>
                  <button type="button" onClick={markCurrentReviewed} style={{ height: 38, padding: '0 17px', borderRadius: 14, border: 'none', background: '#829987', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600 }}><Check size={14} />已回顾，下一条</button>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        ) : null}

        {reviewNotes.length > 0 && !completed && (
          <div style={{ height: 56, padding: '0 24px', borderTop: '1px solid rgba(73,56,28,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button type="button" disabled={index === 0} onClick={() => setIndex(Math.max(0, index - 1))} style={{ border: 'none', background: 'transparent', color: index === 0 ? '#C8C3BA' : '#716C65', cursor: index === 0 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}><ChevronLeft size={15} />上一条</button>
            <div style={{ display: 'flex', gap: 6 }}>{reviewNotes.map((note, itemIndex) => <button key={note.id} type="button" aria-label={`查看第 ${itemIndex + 1} 条`} onClick={() => setIndex(itemIndex)} style={{ width: itemIndex === index ? 22 : 7, height: 7, padding: 0, border: 'none', borderRadius: 999, background: reviewedIds.has(note.id) ? '#829987' : itemIndex === index ? '#B8A06A' : '#D6D1C8', cursor: 'pointer', transition: 'width 0.18s' }} />)}</div>
            <button type="button" disabled={index === reviewNotes.length - 1} onClick={() => setIndex(Math.min(reviewNotes.length - 1, index + 1))} style={{ border: 'none', background: 'transparent', color: index === reviewNotes.length - 1 ? '#C8C3BA' : '#716C65', cursor: index === reviewNotes.length - 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>下一条<ChevronRight size={15} /></button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
