'use client';

import { useEffect, useRef } from 'react';
import { DeskView } from './components/DeskView';
import { useApp } from './lib/store';
import { getNotes, subscribeToUpdates } from './lib/xhs-client';

export default function Home() {
  const { dispatch } = useApp();
  const notesSignatureRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    const load = async (showLoading = false) => {
      if (showLoading) dispatch({ type: 'SET_LOADING', payload: true });
      try {
        const notes = await getNotes();
        if (cancelled) return;
        const signature = notes.map((note) => [
          note.id,
          note.title,
          note.category,
          (note.tags || []).join(','),
          note.transcriptText || '',
          note.transcriptEngine || '',
          note.transcriptSkipped ? '1' : '0',
          note.transcriptStatus || '',
          note.aiSummary || '',
          note.aiExpansion || '',
          note.videoStatus || '',
          note.videoError || '',
          note.savedAt.getTime(),
        ].join('\u0001')).join('\u0002');
        if (signature !== notesSignatureRef.current) {
          notesSignatureRef.current = signature;
          dispatch({ type: 'SET_NOTES', payload: notes });
        }
      } catch {
        if (!cancelled) dispatch({ type: 'SET_ERROR', payload: '加载失败' });
      } finally {
        if (showLoading && !cancelled) dispatch({ type: 'SET_LOADING', payload: false });
      }
    };

    void load(true);
    const fallbackId = window.setInterval(() => void load(), 30000);
    const unsubscribe = subscribeToUpdates(() => void load());

    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(fallbackId);
    };
  }, [dispatch]); // dispatch is stable, no infinite loop

  return <DeskView />;
}
