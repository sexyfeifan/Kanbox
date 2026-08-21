'use client';

import { useEffect, useRef } from 'react';
import { DeskView } from './components/DeskView';
import { useApp } from './lib/store';
import { getNotes, subscribeToUpdates } from './lib/xhs-client';

export default function Home() {
  const { dispatch } = useApp();
  const notesSignatureRef = useRef('');

  // 全局错误兜底：让渲染期外的静默失败可见
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('[GlobalError]', event.error ?? event.message);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error('[UnhandledRejection]', event.reason);
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

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
        dispatch({ type: 'SET_ERROR', payload: null });
      } catch {
        // Keep the last successful snapshot visible during a sidecar restart or timeout.
        if (!cancelled) dispatch({ type: 'SET_ERROR', payload: '本地服务暂时断开，当前显示上次成功加载的内容' });
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
