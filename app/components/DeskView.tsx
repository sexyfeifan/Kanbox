'use client';

import { useState, useEffect, useRef, useMemo, useCallback, type DragEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Heart,
  Loader2,
  Plus,
  Pencil,
  Check,
  BookMarked,
  Trash2,
  Search,
  Puzzle,
  Bot,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Play,
  Link,
  Download,
  Sparkles,
} from 'lucide-react';
import { Note } from '../types/xiaohongshu';
import { useNotes, useApp } from '../lib/store';
import {
  formatNumber,
  connectLocalAgent,
  deleteStoredNote,
  exportNotes,
  exportNotesMarkdown,
  exportNotesHtml,
  formatDate,
  getLocalServiceHealth,
  getLocalSetupInfo,
  getNotes,
  importSharedNote,
  openBrowserExtensionSetup,
  openExternalUrl,
  updateNote,
  getDataInfo,
  createBackup,
  restoreFromBackup,
  checkDataIntegrity,
  repairNote,
  getAllTags,
  renameTag,
  deleteTag,
  getNoteSummary,
  getNoteExpansion,
  transcribeNoteVideo,
  getAiSettings,
  saveAiSettings,
  testAiConnection,
  testTranscribeConnection,
  batchProcessAi,
  getPipelineStatus,
  subscribeToPipeline,
} from '../lib/xhs-client';
import type { AgentClient, LocalServiceHealth, LocalSetupInfo, AiSettings, PipelineStatus } from '../lib/xhs-client';
import { renderMarkdown } from '../lib/markdown';
import {
  acceptsExternalNoteDrag,
  parseDraggedCardInput,
  selectDraggedNoteInput,
} from '../lib/drag-import.mjs';
import { t, setLanguage, getLanguage, getAvailableLanguages } from '../lib/i18n.mjs';
import {
  CARD_H,
  CARD_IMAGE_H,
  CARD_TITLE_LINES,
  CARD_W,
  EXPANDED_GRID_GAP_X,
  EXPANDED_GRID_GAP_Y,
} from '../lib/desk-card-metrics.mjs';
import { shouldUseLightweightCanvas } from '../lib/desk-performance.mjs';
import {
  formatMediaTime,
  paginatePlainText,
  paginateTimedSegments,
} from '../lib/video-transcript.mjs';
import { stripDuplicateTagSuffix } from '../lib/note-content.mjs';
import { filterNotesByQuery } from '../../scripts/lib/note-search.mjs';
import {
  createDeskGroup,
  deleteDeskGroup,
  ensureDeskState,
  getNotesInGroup,
  moveNoteToGroup,
  renameDeskGroup,
  reorderGroup,
} from '../lib/desk-workspace.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────
const TITLEBAR_SAFE_TOP = 52;
const TITLEBAR_SAFE_LEFT = 12;
const DRAG_PAYLOAD_PREFIX = 'KANBOX_NOTE:';

type ImportPhase = 'idle' | 'dragging' | 'recognized' | 'processing' | 'complete' | 'error';

type ImportFeedback = {
  phase: ImportPhase;
  title: string;
  message: string;
};

const IDLE_IMPORT_FEEDBACK: ImportFeedback = { phase: 'idle', title: '', message: '' };

function getDraggedNoteTitle(input: string): string {
  const card = parseDraggedCardInput(input);
  if (card?.title) return card.title;

  const markerIndex = input.indexOf(DRAG_PAYLOAD_PREFIX);
  if (markerIndex === -1) return '这条笔记';

  try {
    const payload = JSON.parse(input.slice(markerIndex + DRAG_PAYLOAD_PREFIX.length));
    return typeof payload?.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 52)
      : '这条笔记';
  } catch {
    return '这条笔记';
  }
}

// ── Category colors ───────────────────────────────────────────────────────────
const CAT_COLORS: Record<string, string> = {
  工作方法: '#829987', 设计美学: '#6B8799', 学习方法: '#B89A52',
  身心健康: '#CC8C73', 食物科学: '#8BA882', 阅读思考: '#9B8EA0',
  摄影:     '#7A95A8', 生活哲学: '#C4A882', 咖啡科学: '#A67C52',
  植物:     '#6E9478', 空间美学: '#8B9AB5', 茶文化:   '#7B8F6E',
  艺术:     '#B5849B', 创作:     '#B07856', 户外:     '#6E8E7A',
  AI工具:   '#6B8799', 编程开发: '#5E7FA3', 旅行户外: '#6E8E7A',
  美食餐饮: '#A67C52', 影像创作: '#B07856', 方法论:   '#829987',
  生活方式: '#8BA882',
};
const catColor = (c: string) => CAT_COLORS[c] ?? '#829987';

function isNewNote(savedAt: Date | string): boolean {
  const date = savedAt instanceof Date ? savedAt : new Date(savedAt);
  const now = new Date();
  const hoursDiff = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
  return hoursDiff < 24;
}

// ── Seeded random ─────────────────────────────────────────────────────────────
function sr(seed: number): number {
  return ((seed * 9301 + 49297) % 233280) / 233280;
}

type Pos = { x: number; y: number; rot: number; z: number; breathOffset: number };
type DeskGroup = {
  id: string;
  name: string;
  kind: 'auto' | 'custom' | 'inbox';
  sourceCategory?: string;
};
type DeskState = {
  groups: DeskGroup[];
  noteGroupMap: Record<string, string>;
  knownNoteIds?: string[];
};
type GroupLabel = {
  groupId: string;
  name: string;
  y: number;
  x: number;
  color: string;
  kind: DeskGroup['kind'];
  noteCount: number;
};
const DESK_WORKSPACE_STORAGE_KEY = 'kanbox:desk-workspace:v1';

// ── Organized layout (cards grouped by category clusters) ─────────────────────
type OrgResult = {
  positions: Record<string, Pos>;
  labels: GroupLabel[];
};

function buildOrganized(
  notes: Note[],
  groups: DeskGroup[],
  noteGroupMap: Record<string, string>,
  w: number,
  activeGroupId: string | null,
  hideEmptyGroups = false,
): OrgResult {
  const visibleGroups = groups.filter((group) => {
    const noteCount = getNotesInGroup(notes, noteGroupMap, group.id).length;
    if (hideEmptyGroups) return noteCount > 0;
    if (group.kind === 'auto') return noteCount > 0;
    return group.id !== 'inbox' || noteCount > 0;
  });
  const grouped: Record<string, Note[]> = {};
  visibleGroups.forEach((group) => {
    grouped[group.id] = getNotesInGroup(notes, noteGroupMap, group.id);
  });

  const clusterCols = w > 900 ? 3 : 2;
  const clusterPadX = 60;
  const clusterH = 360;
  const availableW = w - clusterPadX * 2;
  const clusterW = availableW / clusterCols;

  const positions: Record<string, Pos> = {};
  const labels: OrgResult['labels'] = [];

  visibleGroups.forEach((group, ci) => {
    const col = ci % clusterCols;
    const row = Math.floor(ci / clusterCols);

    const cx = clusterPadX + col * clusterW + clusterW / 2;
    const cy = 20 + row * clusterH + clusterH / 2;

    const labelX = cx - 30;
    const groupColor = group.kind === 'auto'
      ? catColor(group.sourceCategory || group.name)
      : group.kind === 'inbox'
        ? '#A67C52'
        : '#829987';
    labels.push({
      groupId: group.id,
      name: group.name,
      y: cy - 155,
      x: labelX,
      color: groupColor,
      kind: group.kind,
      noteCount: grouped[group.id].length,
    });

    const catNotes = grouped[group.id];
    const isExpanded = group.id === activeGroupId;

    catNotes.forEach((note, i) => {
      if (isExpanded) {
        // 展开状态：以标签为中心向下进行网格平铺
        const cols = w > 600 ? 3 : 2;
        const gapX = EXPANDED_GRID_GAP_X;
        const gapY = EXPANDED_GRID_GAP_Y;
        const gridCol = i % cols;
        const gridRow = Math.floor(i / cols);

        const totalWidth = (Math.min(catNotes.length, cols) - 1) * gapX;
        const offsetX = gridCol * gapX - totalWidth / 2;
        const offsetY = gridRow * gapY;

        positions[note.id] = {
          x: cx + offsetX,
          y: cy + 30 + offsetY,
          rot: 0,
          z: 300 + i,
          breathOffset: 0
        };
      } else {
        // 折叠状态：原本的自然凌乱堆叠
        const angle = (i * 1.618) % (Math.PI * 2);
        const radius = Math.min(i * 3, 25) + (sr(i * 3 + ci) - 0.5) * 20;
        const offsetX = Math.cos(angle) * radius + (sr(i * 7 + ci) - 0.5) * 20;
        const offsetY = Math.sin(angle) * radius * 0.6 + (sr(i * 11 + ci) - 0.5) * 15;

        positions[note.id] = {
          x: cx + offsetX,
          y: cy + offsetY,
          rot: (sr(i * 13 + ci * 3 + 2) - 0.5) * 28,
          z: Math.floor(sr(i * 17 + ci * 2 + 3) * 20) + ci * 15,
          breathOffset: sr(i * 19 + ci) * 3
        };
      }
    });
  });

  return { positions, labels };
}

// ── Expanded note reader ──────────────────────────────────────────────────────
function ExpandedCard({
  note,
  onClose,
  onDelete,
  onUpdate,
  onTranscribe,
  onNoteChanged,
  isDeleting,
}: {
  note: Note;
  onClose: () => void;
  onDelete: () => void;
  onUpdate: (updates: { title?: string; tags?: string[] }) => void;
  onTranscribe: () => Promise<void>;
  onNoteChanged: (note: Note) => void;
  isDeleting: boolean;
}) {
  const color = catColor(note.category);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(() => new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showOcr, setShowOcr] = useState(false);
  const [readerTab, setReaderTab] = useState<'note' | 'transcript'>(
    note.type === 'video' ? 'transcript' : 'note',
  );
  const [readerPage, setReaderPage] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(note.title);
  const [editingTagIndex, setEditingTagIndex] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [newTagDraft, setNewTagDraft] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [summary, setSummary] = useState(note.aiSummary || '');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [expansion, setExpansion] = useState(note.aiExpansion || '');
  const [expansionLoading, setExpansionLoading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [expansionError, setExpansionError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const newTagInputRef = useRef<HTMLInputElement>(null);
  const sourceImageUrls = Array.from(new Set(
    note.imageUrls?.length ? note.imageUrls : (note.coverUrl ? [note.coverUrl] : []),
  ));
  const imageUrls = sourceImageUrls.filter(imageUrl => !failedImageUrls.has(imageUrl));
  const resolvedImageIndex = Math.min(activeImageIndex, Math.max(imageUrls.length - 1, 0));
  const activeImageUrl = imageUrls[resolvedImageIndex];
  const rawContent = stripDuplicateTagSuffix(note.rawContent || '', note.tags);
  const ocrText = (note.ocrText || '').trim();
  const isVideo = note.type === 'video' && Boolean(note.videoUrl);
  const notePages = useMemo(
    () => paginatePlainText(rawContent || '这条笔记没有可见正文。') as string[],
    [rawContent],
  );
  const transcriptPages = useMemo(
    () => paginateTimedSegments(note.transcriptSegments || []) as Array<Array<{
      start: number;
      duration: number;
      text: string;
    }>>,
    [note.transcriptSegments],
  );
  const readerPages = readerTab === 'transcript'
    ? transcriptPages
    : notePages;
  const resolvedReaderPage = Math.min(readerPage, Math.max(readerPages.length - 1, 0));

  const changeReaderTab = (tab: 'note' | 'transcript') => {
    setReaderTab(tab);
    setReaderPage(0);
  };

  const seekVideo = (time: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, time);
    void videoRef.current.play();
  };

  const markImageFailed = (imageUrl: string) => {
    setFailedImageUrls(current => {
      if (current.has(imageUrl)) return current;
      const next = new Set(current);
      next.add(imageUrl);
      return next;
    });
  };

  useEffect(() => {
    if (lightboxIndex === null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setLightboxIndex(i => (i !== null ? (i - 1 + imageUrls.length) % imageUrls.length : null));
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex(i => (i !== null ? (i + 1) % imageUrls.length : null));
      } else if (e.key === 'Escape') {
        setLightboxIndex(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxIndex, imageUrls.length]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(225,221,214,0.9)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        padding: 24,
      }}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.94, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 350, damping: 30 }}
        onClick={e => e.stopPropagation()}
        style={{
          background: '#FDFCFA',
          borderRadius: 22,
          width: '100%',
          maxWidth: 1080,
          height: 'min(86vh, 820px)',
          overflow: 'hidden',
          boxShadow: '0 32px 100px rgba(55,45,25,0.28), 0 12px 32px rgba(55,45,25,0.15)',
          display: 'flex',
        }}
      >
        {/* Visual gallery */}
        <div style={{
          flex: '0 0 58%',
          display: 'flex',
          borderRight: '1px solid rgba(0,0,0,0.06)',
          background: '#EAE7E0',
          minWidth: 0,
          position: 'relative',
        }}>
          {!isVideo && imageUrls.length > 1 && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              overflowY: 'auto',
              padding: '18px 10px 18px 14px',
              background: 'rgba(244,242,237,0.72)',
              borderRight: '1px solid rgba(0,0,0,0.05)',
              flexShrink: 0,
            }}>
              {imageUrls.map((imageUrl, index) => (
                <button
                  key={imageUrl}
                  type="button"
                  onClick={() => setActiveImageIndex(index)}
                  aria-label={`查看第 ${index + 1} 张图片`}
                  style={{
                    width: 54,
                    height: 68,
                    padding: 0,
                    flexShrink: 0,
                    overflow: 'hidden',
                    borderRadius: 9,
                    border: index === resolvedImageIndex
                      ? `2px solid ${color}`
                      : '2px solid transparent',
                    background: '#E8E5DE',
                    cursor: 'pointer',
                    opacity: index === resolvedImageIndex ? 1 : 0.68,
                    boxShadow: index === resolvedImageIndex ? `0 4px 14px ${color}30` : 'none',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl}
                    alt=""
                    draggable={false}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onError={() => markImageFailed(imageUrl)}
                  />
                </button>
              ))}
            </div>
          )}
          <div style={{
            flex: 1,
            minWidth: 0,
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 28,
            overflow: 'hidden',
          }}>
            {isVideo ? (
              <video
                ref={videoRef}
                src={note.videoUrl}
                poster={note.coverUrl || undefined}
                controls
                playsInline
                preload="metadata"
                style={{
                  width: '100%', height: '100%', objectFit: 'contain', display: 'block',
                  background: '#171715', borderRadius: 12,
                }}
              />
            ) : activeImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeImageUrl}
                alt={note.title}
                draggable={false}
                onClick={() => setLightboxIndex(resolvedImageIndex)}
                style={{
                  width: '100%', height: '100%', objectFit: 'contain', display: 'block',
                  filter: 'saturate(0.9) contrast(1.02)',
                  cursor: 'zoom-in',
                }}
                onError={() => markImageFailed(activeImageUrl)}
              />
            ) : (
              <div style={{
                width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `linear-gradient(145deg, ${color}18, ${color}40)`,
                color, fontFamily: '"Playfair Display", Georgia, serif', fontSize: 72, fontWeight: 600,
              }}>
                {note.title.slice(0, 1)}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              style={{
                position: 'absolute', top: 16, left: 16,
                background: 'rgba(253,252,250,0.92)', backdropFilter: 'blur(10px)',
                border: '1px solid rgba(0,0,0,0.05)', borderRadius: '50%',
                width: 36, height: 36, cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 12px rgba(0,0,0,0.1)',
              }}
            >
              <X size={15} color="#404047" strokeWidth={2} />
            </button>
            {!isVideo && imageUrls.length > 1 && (
              <div style={{
                position: 'absolute', right: 16, bottom: 16, padding: '5px 10px', borderRadius: 999,
                background: 'rgba(50,48,44,0.72)', color: '#fff', fontSize: 10.5,
                backdropFilter: 'blur(8px)',
              }}>
                {resolvedImageIndex + 1} / {imageUrls.length}
              </div>
            )}
          </div>
        </div>

        {/* Original note */}
        <div style={{
          flex: 1,
          minWidth: 0,
          overflowY: 'auto',
          padding: '30px 32px 34px',
          background: '#FDFCFA',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 9px', borderRadius: 999, background: `${color}14`,
              color, fontSize: 10.5, fontWeight: 600,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
              {note.category}
            </div>
            {confirmingDelete ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <button type="button" onClick={() => setConfirmingDelete(false)} disabled={isDeleting}
                  style={{ border: 'none', background: 'transparent', color: '#8C8780', fontSize: 11, cursor: 'pointer', padding: '5px 7px' }}>
                  {t('cancel')}
                </button>
                <button type="button" onClick={onDelete} disabled={isDeleting}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, border: 'none', borderRadius: 999,
                    background: 'rgba(181,106,91,0.11)', color: '#A85F52', fontSize: 11,
                    cursor: isDeleting ? 'default' : 'pointer', padding: '6px 10px',
                  }}>
                  {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {isDeleting ? t('deleting') : t('confirmDelete')}
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmingDelete(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent',
                  color: '#AAA49C', fontSize: 10.5, cursor: 'pointer', padding: '5px 4px',
                }}>
                <Trash2 size={12} strokeWidth={1.7} /> {t('delete')}
              </button>
            )}
          </div>

          <h2
            onClick={() => { setEditingTitle(true); setTitleDraft(note.title); }}
            style={{
              margin: '22px 0 10px', fontFamily: '"Playfair Display", Georgia, serif',
              fontSize: 25, lineHeight: 1.38, fontWeight: 600, color: '#35343A', letterSpacing: '-0.02em',
              cursor: 'text', borderRadius: 6, padding: '2px 4px', marginLeft: -4,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.03)'; }}
            onMouseLeave={(e) => { if (!editingTitle) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                autoFocus
                onFocus={() => { setTimeout(() => titleInputRef.current?.select(), 0); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (titleDraft.trim() && titleDraft.trim() !== note.title) {
                      onUpdate({ title: titleDraft.trim() });
                    }
                    setEditingTitle(false);
                  }
                  if (e.key === 'Escape') { setEditingTitle(false); }
                }}
                onBlur={() => {
                  if (titleDraft.trim() && titleDraft.trim() !== note.title) {
                    onUpdate({ title: titleDraft.trim() });
                  }
                  setEditingTitle(false);
                }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%', border: 'none', outline: 'none', background: 'transparent',
                  fontFamily: '"Playfair Display", Georgia, serif',
                  fontSize: 25, lineHeight: 1.38, fontWeight: 600, color: '#35343A', letterSpacing: '-0.02em',
                  padding: 0,
                }}
              />
            ) : (
              note.title
            )}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#9A958D', fontSize: 11 }}>
            <span>@{note.author.name}</span>
            <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#C7C2BA' }} />
            <span>{formatDate(note.savedAt)}</span>
            {note.sourceUrl && (
              <a
                href={note.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  color: '#8D8881', fontSize: 11, textDecoration: 'none',
                  padding: '4px 8px', borderRadius: 6,
                  border: '1px solid rgba(0,0,0,0.06)',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.04)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <ExternalLink size={11} />
                {t('viewOriginal')}
              </a>
            )}
          </div>

          {note.type === 'video' ? (
            <div style={{
              display: 'flex', gap: 3, margin: '24px 0 22px', padding: 3,
              borderRadius: 12, background: 'rgba(72,67,58,0.055)',
            }}>
              {([
                ['note', t('noteContent')],
                ['transcript', t('videoTranscript')],
              ] as const).map(([tab, label]) => {
                const active = readerTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => changeReaderTab(tab)}
                    style={{
                      flex: 1, height: 34, border: 'none', borderRadius: 9,
                      background: active ? '#FDFCFA' : 'transparent',
                      boxShadow: active ? '0 2px 9px rgba(62,54,41,0.08)' : 'none',
                      color: active ? '#46433E' : '#99938B',
                      fontSize: 11.5, fontWeight: active ? 600 : 500, cursor: 'pointer',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ height: 1, background: 'rgba(0,0,0,0.06)', margin: '24px 0' }} />
          )}

          {readerTab === 'note' && (
            <p style={{
              margin: 0, fontSize: 13.5, color: '#5E5A54', lineHeight: 1.9,
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            }}>
              {notePages[resolvedReaderPage] || '这条笔记没有可见正文。'}
            </p>
          )}

          {readerTab === 'transcript' && (
            transcriptPages.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {note.transcriptEngine === 'ai' && (
                  <div style={{
                    alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '3px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 600,
                    background: 'rgba(94,127,163,0.1)', color: '#4F6A8E',
                  }}>
                    <Bot size={12} strokeWidth={1.8} /> {t('transcriptEngineAi')}
                  </div>
                )}
                {transcriptPages[resolvedReaderPage]?.map((segment, index) => (
                  <div key={`${segment.start}-${index}`} style={{ display: 'grid', gridTemplateColumns: '42px 1fr', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => seekVideo(segment.start)}
                      style={{
                        alignSelf: 'start', border: 'none', borderRadius: 7, padding: '4px 0',
                        background: `${color}14`, color, fontSize: 10, cursor: isVideo ? 'pointer' : 'default',
                      }}
                    >
                      {formatMediaTime(segment.start)}
                    </button>
                    <p style={{ margin: 0, color: '#5E5A54', fontSize: 13.5, lineHeight: 1.8 }}>
                      {segment.text}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ margin: 0, color: '#9A958D', fontSize: 12.5, lineHeight: 1.8 }}>
                  {note.videoError || (note.transcriptSkipped ? '已在设置中关闭自动转写，可手动生成文稿。' : '这条视频没有识别到可转写的语音。')}
                </p>
                {note.videoUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setTranscribing(true);
                      void onTranscribe().finally(() => setTranscribing(false));
                    }}
                    disabled={transcribing}
                    style={{
                      alignSelf: 'flex-start', height: 30, padding: '0 14px', borderRadius: 8,
                      border: '1px solid rgba(130,153,135,0.3)', background: 'rgba(130,153,135,0.06)',
                      color: '#4F6254', fontSize: 11, fontWeight: 600, cursor: transcribing ? 'default' : 'pointer',
                    }}
                  >
                    {transcribing ? '转写中...' : '生成文稿'}
                  </button>
                )}
              </div>
            )
          )}

          {readerPages.length > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
              marginTop: 24, paddingTop: 16, borderTop: '1px solid rgba(0,0,0,0.05)',
            }}>
              <button
                type="button"
                aria-label="上一页"
                onClick={() => setReaderPage((page) => Math.max(0, page - 1))}
                disabled={resolvedReaderPage === 0}
                style={{
                  width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(0,0,0,0.06)',
                  background: '#F8F6F2', color: '#777168', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', cursor: resolvedReaderPage === 0 ? 'default' : 'pointer',
                  opacity: resolvedReaderPage === 0 ? 0.35 : 1,
                }}
              >
                <ChevronLeft size={14} />
              </button>
              <span style={{ color: '#AAA49C', fontSize: 10.5 }}>
                {resolvedReaderPage + 1} / {readerPages.length}
              </span>
              <button
                type="button"
                aria-label="下一页"
                onClick={() => setReaderPage((page) => Math.min(readerPages.length - 1, page + 1))}
                disabled={resolvedReaderPage >= readerPages.length - 1}
                style={{
                  width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(0,0,0,0.06)',
                  background: '#F8F6F2', color: '#777168', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', cursor: resolvedReaderPage >= readerPages.length - 1 ? 'default' : 'pointer',
                  opacity: resolvedReaderPage >= readerPages.length - 1 ? 0.35 : 1,
                }}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          {readerTab === 'note' && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 22,
            }}>
              {Array.isArray(note.tags) && note.tags.map((tag, index) => (
                editingTagIndex === index ? (
                  <input
                    key={`tag-edit-${index}`}
                    ref={tagInputRef}
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    autoFocus
                    onFocus={() => { setTimeout(() => tagInputRef.current?.select(), 0); }}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const newTags = [...note.tags];
                        if (tagDraft.trim()) {
                          newTags[index] = tagDraft.trim();
                        } else {
                          newTags.splice(index, 1);
                        }
                        onUpdate({ tags: newTags });
                        setEditingTagIndex(null);
                      }
                      if (e.key === 'Escape') { setEditingTagIndex(null); }
                      if (e.key === 'Backspace' && tagDraft === '') {
                        const newTags = [...note.tags];
                        newTags.splice(index, 1);
                        onUpdate({ tags: newTags });
                        setEditingTagIndex(null);
                      }
                    }}
                    onBlur={() => {
                      if (tagDraft.trim() && tagDraft.trim() !== tag) {
                        const newTags = [...note.tags];
                        newTags[index] = tagDraft.trim();
                        onUpdate({ tags: newTags });
                      }
                      setEditingTagIndex(null);
                    }}
                    style={{
                      padding: '4px 8px', borderRadius: 6, border: `1px solid ${color}50`,
                      background: `${color}10`, color: '#5E5A54', fontSize: 10.5,
                      outline: 'none', width: 80,
                    }}
                  />
                ) : (
                  <span
                    key={tag}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingTagIndex(index);
                      setTagDraft(tag);
                    }}
                    style={{
                      padding: '4px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.035)',
                      color: '#8D8881', fontSize: 10.5, cursor: 'pointer',
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.07)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.035)'; }}
                  >
                    #{tag}
                  </span>
                )
              ))}
              {addingTag ? (
                <input
                  key="new-tag-input"
                  ref={newTagInputRef}
                  value={newTagDraft}
                  onChange={(e) => setNewTagDraft(e.target.value)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const trimmed = newTagDraft.trim();
                      if (trimmed && !(note.tags || []).includes(trimmed)) {
                        onUpdate({ tags: [...(note.tags || []), trimmed] });
                      }
                      setNewTagDraft('');
                      setAddingTag(false);
                    }
                    if (e.key === 'Escape') { setAddingTag(false); setNewTagDraft(''); }
                  }}
                  onBlur={() => {
                    const trimmed = newTagDraft.trim();
                    if (trimmed && !(note.tags || []).includes(trimmed)) {
                      onUpdate({ tags: [...(note.tags || []), trimmed] });
                    }
                    setNewTagDraft('');
                    setAddingTag(false);
                  }}
                  placeholder="标签"
                  style={{
                    padding: '4px 8px', borderRadius: 6, border: `1px solid ${color}50`,
                    background: `${color}10`, color: '#5E5A54', fontSize: 10.5,
                    outline: 'none', width: 72,
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddingTag(true);
                  }}
                  style={{
                    width: 22, height: 22, borderRadius: 6,
                    border: '1px dashed rgba(0,0,0,0.12)', background: 'transparent',
                    color: '#A8A29E', fontSize: 12, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'border-color 0.12s, color 0.12s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = color;
                    (e.currentTarget as HTMLElement).style.color = color;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(0,0,0,0.12)';
                    (e.currentTarget as HTMLElement).style.color = '#A8A29E';
                  }}
                  aria-label="添加标签"
                >
                  +
                </button>
              )}
            </div>
          )}

          {readerTab === 'note' && ocrText && (
            <div style={{ marginTop: 26, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 18 }}>
              <button type="button" onClick={() => setShowOcr((value) => !value)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
                  color: '#666159', fontSize: 12, fontWeight: 600,
                }}>
                <span>{t('imageText')}</span>
                <span style={{ color: '#AAA49C', fontSize: 10.5, fontWeight: 400 }}>
                  {showOcr ? '收起' : '展开 OCR'}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {showOcr && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{
                      margin: '14px 0 0', overflow: 'hidden', whiteSpace: 'pre-wrap',
                      color: '#777168', fontSize: 12, lineHeight: 1.8,
                    }}>
                    {ocrText}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          )}

          {readerTab === 'note' && (
            <div style={{ marginTop: 20, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 16 }}>
              <button
                type="button"
                onClick={async () => {
                  if (summary) { setSummary(''); return; }
                  setSummaryLoading(true);
                  setSummaryError('');
                  try {
                    const result = await getNoteSummary(note.id);
                    setSummary(result.summary);
                    if (result.note) onNoteChanged(result.note);
                  } catch (error) {
                    setSummaryError(error instanceof Error ? error.message : '生成失败');
                  } finally { setSummaryLoading(false); }
                }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
                  color: '#666159', fontSize: 12, fontWeight: 600,
                }}>
                <span>{t('aiSummary')}</span>
                <span style={{ color: '#AAA49C', fontSize: 10.5, fontWeight: 400 }}>
                  {summaryLoading ? '生成中...' : summary ? '收起' : '生成'}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {summary && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{
                      margin: '12px 0 0', overflow: 'hidden',
                      color: '#5E5A54', fontSize: 12.5, lineHeight: 1.8,
                      padding: '10px 12px', borderRadius: 10,
                      background: 'rgba(130,153,135,0.06)', border: '1px solid rgba(130,153,135,0.1)',
                    }}>
                    {renderMarkdown(summary)}
                  </motion.div>
                )}
                {summaryError && !summary && (
                  <motion.p
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    style={{ margin: '12px 0 0', color: '#B56A5B', fontSize: 11.5, lineHeight: 1.7 }}>
                    {summaryError}
                  </motion.p>
                )}
              </AnimatePresence>

              <button
                type="button"
                onClick={async () => {
                  if (expansion) { setExpansion(''); return; }
                  setExpansionLoading(true);
                  setExpansionError('');
                  try {
                    const result = await getNoteExpansion(note.id);
                    setExpansion(result.expansion);
                    if (result.note) onNoteChanged(result.note);
                  } catch (error) {
                    setExpansionError(error instanceof Error ? error.message : '生成失败');
                  } finally { setExpansionLoading(false); }
                }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  border: 'none', background: 'transparent', padding: '10px 0 0', cursor: 'pointer',
                  color: '#666159', fontSize: 12, fontWeight: 600,
                }}>
                <span>{t('aiExpand')}</span>
                <span style={{ color: '#AAA49C', fontSize: 10.5, fontWeight: 400 }}>
                  {expansionLoading ? t('aiExpandHint') : expansion ? '收起' : '生成'}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {expansion && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{
                      margin: '12px 0 0', overflow: 'hidden',
                      color: '#4F5A63', fontSize: 12.5, lineHeight: 1.8,
                      padding: '10px 12px', borderRadius: 10,
                      background: 'rgba(94,127,163,0.06)', border: '1px solid rgba(94,127,163,0.1)',
                    }}>
                    {renderMarkdown(expansion)}
                  </motion.div>
                )}
                {expansionError && !expansion && (
                  <motion.p
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    style={{ margin: '12px 0 0', color: '#B56A5B', fontSize: 11.5, lineHeight: 1.7 }}>
                    {expansionError}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          )}

          {note.mediaStatus === 'partial' && (
            <p style={{ marginTop: 16, fontSize: 10.5, color: '#B56A5B', lineHeight: 1.5 }}>
              {note.mediaError || '部分图片或文字未能完整保存。'}
            </p>
          )}

          {note.videoStatus === 'partial' && note.videoError && readerTab === 'note' && (
            <p style={{ marginTop: 16, fontSize: 10.5, color: '#B56A5B', lineHeight: 1.5 }}>
              {note.videoError}
            </p>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', gap: 18, marginTop: 28, paddingTop: 18,
            borderTop: '1px solid rgba(0,0,0,0.05)', color: '#AAA49C', fontSize: 11,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Heart size={13} strokeWidth={1.6} /> {formatNumber(note.likes)}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <BookMarked size={13} strokeWidth={1.6} /> {formatNumber(note.collects)}
            </span>
          </div>
        </div>
      </motion.div>
      {lightboxIndex !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setLightboxIndex(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 400,
            background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={imageUrls[lightboxIndex]}
            alt=""
            style={{ maxWidth: '95vw', maxHeight: '95vh', objectFit: 'contain' }}
          />
          <button onClick={(e) => { e.stopPropagation(); setLightboxIndex(null); }}
            style={{ position: 'absolute', top: 20, right: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 40, height: 40, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={20} />
          </button>
          {imageUrls.length > 1 && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setLightboxIndex((lightboxIndex - 1 + imageUrls.length) % imageUrls.length); }}
                style={{ position: 'absolute', left: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 44, height: 44, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronLeft size={24} />
              </button>
              <button onClick={(e) => { e.stopPropagation(); setLightboxIndex((lightboxIndex + 1) % imageUrls.length); }}
                style={{ position: 'absolute', right: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 44, height: 44, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronRight size={24} />
              </button>
            </>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

// ── Individual card with breathe animation ────────────────────────────────────
function DeskCard({
  note, pos, isDimmed, lightweight, onClick, onDragStart, onDragEnd, batchMode, isSelected, onToggleSelect
}: {
  note: Note;
  pos: Pos;
  isDimmed?: boolean;
  lightweight?: boolean;
  onClick: () => void;
  onDragStart?: (noteId: string) => void;
  onDragEnd?: () => void;
  batchMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}) {
  const color = catColor(note.category);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{
        x: pos.x,
        y: pos.y,
        rotate: pos.rot,
        zIndex: isDimmed ? 0 : pos.z,
        opacity: isDimmed ? 0.35 : 1,
        scale: isDimmed ? 0.75 : 1,
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 24, mass: 0.8 }}
      whileHover={isDimmed ? undefined : { scale: 1.06, zIndex: pos.z + 100, transition: { duration: 0.15 } }}
      whileTap={isDimmed ? undefined : { scale: 0.96 }}
      onClick={isDimmed ? undefined : (batchMode ? onToggleSelect : onClick)}
      style={{
        position: 'absolute',
        width: CARD_W,
        left: -CARD_W / 2,
        top: -CARD_H / 2,
        cursor: isDimmed ? 'default' : (batchMode ? 'pointer' : 'grab'),
        pointerEvents: isDimmed ? 'none' : 'auto',
        transformOrigin: 'center center',
        willChange: 'transform, opacity',
      }}
      draggable={!isDimmed && !batchMode}
      title={note.title}
      onDragStart={() => onDragStart?.(note.id)}
      onDragEnd={() => onDragEnd?.()}
    >
      <motion.div
        animate={lightweight ? undefined : {
          scale: [1, 1.015, 1],
          y: [0, -2, 0],
        }}
        transition={lightweight ? undefined : {
          duration: 3,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: pos.breathOffset,
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <div style={{
          background: '#FDFCFA', borderRadius: 10,
          padding: '7px 7px 18px',
          boxShadow: `
            0 2px 6px rgba(55,45,25,0.08),
            0 8px 24px rgba(55,45,25,0.10),
            0 0 0 1px rgba(0,0,0,0.02)
          `,
          userSelect: 'none',
        }}>
          <div style={{
            borderRadius: 6,
            overflow: 'hidden',
            height: CARD_IMAGE_H,
            background: '#f0f0f0',
            position: 'relative',
          }}>
            {note.coverUrl ? (
              <>
                {/* External note images cannot use Next Image without a stable host allowlist. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={note.coverUrl}
                  alt={note.title}
                  draggable={false}
                  style={{
                    width: '100%', height: '100%',
                    objectFit: 'cover', display: 'block',
                    filter: 'saturate(0.78) contrast(1.06) sepia(0.05)',
                  }}
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '0'; }}
                />
              </>
            ) : (
              <div style={{
                width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `linear-gradient(145deg, ${color}22, ${color}55)`,
                color, fontFamily: '"Playfair Display", Georgia, serif', fontSize: 38, fontWeight: 600,
              }}>
                {note.title.slice(0, 1)}
              </div>
            )}
            {note.type === 'video' && (
              <span style={{
                position: 'absolute', top: 7, right: 7, width: 23, height: 23,
                borderRadius: '50%', background: 'rgba(42,40,36,0.72)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(6px)', boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
              }}>
                <Play size={10} fill="currentColor" strokeWidth={1.5} style={{ marginLeft: 1 }} />
              </span>
            )}
            {batchMode && (
              <div style={{
                position: 'absolute', top: 7, left: 7,
                width: 22, height: 22, borderRadius: 6,
                background: isSelected ? '#829987' : 'rgba(253,252,250,0.92)',
                border: isSelected ? 'none' : '2px solid rgba(0,0,0,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              }}>
                {isSelected && <Check size={14} strokeWidth={2.5} color="#fff" />}
              </div>
            )}
            {isNewNote(note.savedAt) && !note.type && (
              <span style={{
                position: 'absolute', top: 7, left: 7,
                width: 8, height: 8, borderRadius: '50%',
                background: '#829987',
                boxShadow: '0 0 0 2px rgba(130,153,135,0.3)',
              }} />
            )}
          </div>

          <div style={{ padding: '7px 3px 0' }}>
            <span style={{
              display: 'inline-block',
              fontSize: 8.5,
              fontWeight: 600,
              color,
              background: `${color}18`,
              borderRadius: 3,
              padding: '1px 5px',
              letterSpacing: '0.02em',
              marginBottom: 4,
            }}>
              {note.category}
            </span>
            <p style={{
              fontFamily: '"Playfair Display", Georgia, serif',
              fontSize: 12.5,
              fontWeight: 500,
              color: '#3A3840',
              lineHeight: 1.52,
              letterSpacing: '-0.003em',
              display: '-webkit-box',
              WebkitLineClamp: CARD_TITLE_LINES,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              margin: 0,
            }}>
              {note.title}
            </p>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

type SetupPanel = 'extension' | 'agent';

function SetupDialog({
  panel,
  info,
  loading,
  message,
  connectingClient,
  connectedClients,
  onClose,
  onOpenExtension,
  onConnectAgent,
}: {
  panel: SetupPanel;
  info: LocalSetupInfo | null;
  loading: boolean;
  message: string;
  connectingClient: AgentClient | null;
  connectedClients: Set<AgentClient>;
  onClose: () => void;
  onOpenExtension: () => void;
  onConnectAgent: (client: AgentClient) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 310,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 28,
        background: 'rgba(73, 67, 57, 0.18)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.22 }}
        style={{
          width: 'min(440px, calc(100vw - 48px))',
          borderRadius: 24,
          background: 'rgba(253,252,250,0.98)',
          border: '1px solid rgba(255,255,255,0.72)',
          boxShadow: '0 34px 90px rgba(73,56,28,0.2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '25px 26px 24px', position: 'relative' }}>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              position: 'absolute', top: 18, right: 18,
              width: 34, height: 34, borderRadius: 999,
              border: '1px solid rgba(0,0,0,0.06)', background: '#F4F2ED',
              color: '#6F6B64', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>

          <h2 style={{
            margin: 0, color: '#3A3840', fontFamily: '"Playfair Display", Georgia, serif',
            fontSize: 21, fontWeight: 600,
          }}>
            {panel === 'extension' ? '浏览器插件' : '连接 Agent'}
          </h2>

          {loading ? (
            <div style={{ height: 132, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#829987' }}>
              <Loader2 size={21} className="animate-spin" />
            </div>
          ) : panel === 'extension' ? (
            <div style={{ marginTop: 20 }}>
              {/* Connection status */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 12px', borderRadius: 10,
                background: info?.extension.available ? 'rgba(130,153,135,0.08)' : 'rgba(181,106,91,0.08)',
                marginBottom: 16,
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: info?.extension.available ? '#829987' : '#B56A5B',
                }} />
                <span style={{ fontSize: 12, color: info?.extension.available ? '#4F6254' : '#8F5146' }}>
                  {info?.extension.available
                    ? `扩展文件已找到 (v${info?.extension.version || '?'})`
                    : '扩展文件未找到'}
                </span>
              </div>

              {/* Download button */}
              <a
                href="https://github.com/sexyfeifan/Kanbox/releases/latest"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void openExternalUrl('https://github.com/sexyfeifan/Kanbox/releases/latest').catch(() => {
                    window.location.href = 'https://github.com/sexyfeifan/Kanbox/releases/latest';
                  });
                }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  width: '100%', height: 42, borderRadius: 12,
                  background: '#829987', color: '#fff',
                  fontSize: 13, fontWeight: 600,
                  textDecoration: 'none',
                  marginBottom: 12,
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                }}
              >
                <ExternalLink size={14} />
                从 GitHub 下载扩展
              </a>

              {/* Installation steps */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#3A3840', marginBottom: 10 }}>
                  安装步骤
                </div>
                {[
                  { step: 1, text: '从 GitHub Release 下载 browser-extension.zip' },
                  { step: 2, text: '解压后打开 Chrome → 更多工具 → 扩展程序' },
                  { step: 3, text: '开启右上角「开发者模式」' },
                  { step: 4, text: '点击「加载已解压的扩展程序」，选择解压后的文件夹' },
                ].map(({ step, text }) => (
                  <div key={step} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '6px 0',
                  }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: '#829987', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700, flexShrink: 0,
                    }}>
                      {step}
                    </div>
                    <span style={{ fontSize: 12, color: '#5E5A54', lineHeight: '20px' }}>
                      {text}
                    </span>
                  </div>
                ))}
              </div>

              {/* Open extension folder button (if available) */}
              {info?.extension.available && (
                <button
                  onClick={onOpenExtension}
                  style={{
                    width: '100%', height: 38, borderRadius: 10,
                    border: '1px solid rgba(73,56,28,0.07)',
                    background: 'rgba(253,252,250,0.78)',
                    color: '#666159', fontSize: 12, fontWeight: 600,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    marginBottom: 12,
                  }}
                >
                  打开扩展文件夹
                </button>
              )}

              {/* Features list */}
              <details style={{ color: '#8B857D' }}>
                <summary style={{
                  cursor: 'pointer', fontSize: 11, textAlign: 'center',
                  listStylePosition: 'inside', padding: '4px 0',
                }}>
                  安装后可以做什么？
                </summary>
                <div style={{
                  marginTop: 8, padding: '10px 12px', borderRadius: 10,
                  background: '#F5F3EE', fontSize: 11, lineHeight: 1.7
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                    <span>🖱️</span>
                    <span>拖拽笔记卡片到 Kanbox 窗口即可收藏</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                    <span>📋</span>
                    <span>点击笔记详情页右下角按钮一键收藏</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                    <span>🖱️</span>
                    <span>右键笔记链接选择「收藏到 Kanbox」</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span>📺</span>
                    <span>支持小红书、B站、微博、抖音、知乎、快手、头条</span>
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <div style={{ marginTop: 18 }}>
              <div style={{ borderTop: '1px solid rgba(73,56,28,0.08)' }}>
                {([
                  ['codex', 'Codex'],
                  ['claude', 'Claude Code'],
                ] as const).map(([client, label]) => {
                  const detected = info?.agent.clients[client].available;
                  const connected = connectedClients.has(client);
                  const connecting = connectingClient === client;
                  return (
                    <div key={client} style={{
                      minHeight: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                      borderBottom: '1px solid rgba(73,56,28,0.08)',
                    }}>
                      <strong style={{ fontSize: 13.5, color: '#454248', fontWeight: 600 }}>{label}</strong>
                      <button
                        onClick={() => onConnectAgent(client)}
                        disabled={!detected || connecting}
                        style={{
                          width: 94, height: 38, borderRadius: 12,
                          border: connected ? '1px solid rgba(130,153,135,0.28)' : 'none',
                          background: connected ? 'rgba(130,153,135,0.09)' : detected ? '#829987' : '#D2D0CB',
                          color: connected ? '#627567' : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          fontSize: 12, fontWeight: 600,
                          cursor: detected && !connected ? 'pointer' : 'default',
                          opacity: detected ? 1 : 0.58,
                        }}
                      >
                        {connecting ? <Loader2 size={14} className="animate-spin" /> : connected ? <Check size={14} /> : <Bot size={14} />}
                        {connecting ? '连接中' : connected ? '已连接' : detected ? '连接' : '未安装'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {message && (
            <div style={{
              marginTop: 14, color: '#5E7564', fontSize: 11.5, textAlign: 'center',
            }}>{message}</div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
export function DeskView() {
  const { notes, setNotes } = useNotes();
  const { state, dispatch } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [deskState, setDeskState] = useState<DeskState>({ groups: [], noteGroupMap: {}, knownNoteIds: [] });
  const [scrollY, setScrollY] = useState(0);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Note | null>(null);
  const [dims, setDims] = useState({ w: 1200, h: 800 });
  const [serviceHealth, setServiceHealth] = useState<LocalServiceHealth>({ ok: false, source: 'sidecar' });
  const [importFeedback, setImportFeedback] = useState<ImportFeedback>(IDLE_IMPORT_FEEDBACK);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [setupPanel, setSetupPanel] = useState<SetupPanel | null>(null);
  const [setupInfo, setSetupInfo] = useState<LocalSetupInfo | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupMessage, setSetupMessage] = useState('');
  const [connectingClient, setConnectingClient] = useState<AgentClient | null>(null);
  const [connectedClients, setConnectedClients] = useState<Set<AgentClient>>(() => new Set());
  const [pasteUrl, setPasteUrl] = useState('');
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [pasteLoading, setPasteLoading] = useState(false);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'title'>('newest');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [dataInfo, setDataInfo] = useState<{ dataDirectory: string; notesCount: number; mediaSize: number; backupCount: number } | null>(null);
  const [integrityResult, setIntegrityResult] = useState<{ totalNotes: number; healthyNotes: number; brokenNotes: Array<{ id: string; title: string; missingFiles: string[] }> } | null>(null);
  const [checking, setChecking] = useState(false);
  const [backing, setBacking] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // AI settings
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiDraft, setAiDraft] = useState<AiSettings>({
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: 'gpt-4o-mini',
    autoTranscript: true,
    enhanceTranscript: false,
    autoPipeline: true,
    transcribeEndpoint: '',
    transcribeApiKey: '',
    transcribeModel: '',
  });
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [showApiKey, setShowApiKey] = useState(true);
  const [showTranscribeApiKey, setShowTranscribeApiKey] = useState(true);
  const [aiTranscribeTesting, setAiTranscribeTesting] = useState(false);
  const [aiTranscribeTestResult, setAiTranscribeTestResult] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [aiMessage, setAiMessage] = useState('');

  // AI 后台流水线进度（自动流水线 + 手动补跑共用）
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>({
    running: false, status: 'idle', queued: 0, doneCount: 0, totalCount: 0, currentNoteId: null, currentKind: null,
  });
  const [batchProcessing, setBatchProcessing] = useState(false);

  // Onboarding states
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);

  // Tag management states
  const [showTagManager, setShowTagManager] = useState(false);
  const [allTags, setAllTags] = useState<Array<{ name: string; count: number }>>([]);
  const [editingTagName, setEditingTagName] = useState<string | null>(null);
  const [tagEditDraft, setTagEditDraft] = useState('');

  // Group drag-to-reorder states
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  // i18n module is not reactive — force a re-render when the language changes
  // so all `t(...)` / `getLanguage()` call sites refresh.
  const [, setLangVersion] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onLangChange = () => setLangVersion((v) => v + 1);
    window.addEventListener('kanbox:langchange', onLangChange);
    return () => window.removeEventListener('kanbox:langchange', onLangChange);
  }, []);

  // 订阅后台 AI 流水线实时进度（自动流水线 + 手动补跑共用；notes-changed 由 page.tsx 统一刷新）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const unsubscribe = subscribeToPipeline(
      (status) => setPipelineStatus(status),
      () => { /* notes 刷新交给 page.tsx 的 subscribeToUpdates */ },
    );
    return unsubscribe;
  }, []);

  const toggleBatchMode = () => {
    setBatchMode(prev => !prev);
    if (batchMode) setSelectedNoteIds(new Set());
  };

  const toggleNoteSelection = (noteId: string) => {
    setSelectedNoteIds(prev => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const seen = localStorage.getItem('kanbox:onboarding-seen');
    if (!seen && notes.length === 0) {
      setShowOnboarding(true);
    }
  }, []);

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    localStorage.setItem('kanbox:onboarding-seen', 'true');
  };

  const sortNotes = useCallback((notesToSort: Note[]) => {
    const sorted = [...notesToSort];
    switch (sortBy) {
      case 'oldest':
        sorted.sort((a, b) => new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime());
        break;
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
        break;
      case 'newest':
      default:
        sorted.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
        break;
    }
    return sorted;
  }, [sortBy]);

  const loadLocalStatus = async () => {
    setServiceHealth(await getLocalServiceHealth());
  };

  const openSetupPanel = async (panel: SetupPanel) => {
    setSetupPanel(panel);
    setSetupMessage('');
    setSetupLoading(true);
    try {
      setSetupInfo(await getLocalSetupInfo());
    } catch (error) {
      setSetupMessage(error instanceof Error ? error.message : '本地配置服务未连接');
    } finally {
      setSetupLoading(false);
    }
  };

  const handleOpenExtensionSetup = async () => {
    setSetupMessage('');
    try {
      const result = await openBrowserExtensionSetup();
      setSetupMessage(result.message);
    } catch (error) {
      setSetupMessage(error instanceof Error ? error.message : '没有打开插件配置');
    }
  };

  const handleConnectAgent = async (client: AgentClient) => {
    setConnectingClient(client);
    setSetupMessage('');
    try {
      const result = await connectLocalAgent(client);
      setConnectedClients((current) => new Set(current).add(client));
      setSetupMessage(result.message);
    } catch (error) {
      setSetupMessage(error instanceof Error ? error.message : 'Agent 连接失败');
    } finally {
      setConnectingClient(null);
    }
  };

  const dismissImportFeedback = (phase: ImportPhase, delay = 2800) => {
    window.setTimeout(() => {
      setImportFeedback((current) => current.phase === phase ? IDLE_IMPORT_FEEDBACK : current);
    }, delay);
  };

  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        setDims({
          w: containerRef.current.offsetWidth,
          h: containerRef.current.offsetHeight,
        });
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const loadInitialStatus = async () => {
      setServiceHealth(await getLocalServiceHealth());
    };

    void loadInitialStatus();

    const intervalId = window.setInterval(() => void loadInitialStatus(), 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let rawState = {};
    try {
      const saved = window.localStorage.getItem(DESK_WORKSPACE_STORAGE_KEY);
      rawState = saved ? JSON.parse(saved) : {};
    } catch {
      rawState = {};
    }

    const nextState = ensureDeskState(rawState, notes) as DeskState;
    setDeskState(nextState);
  }, [notes]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(DESK_WORKSPACE_STORAGE_KEY, JSON.stringify(deskState));
  }, [deskState]);

  const groupNameById = useMemo(
    () => new Map(deskState.groups.map((group) => [group.id, group.name])),
    [deskState.groups],
  );
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const note of notes) {
      if (note.category && note.category !== '待分类') set.add(note.category);
    }
    return Array.from(set);
  }, [notes]);
  const visibleNotes = useMemo(
    () => {
      const filtered = filterNotesByQuery(
        notes,
        searchQuery,
        (note: Note) => groupNameById.get(deskState.noteGroupMap?.[note.id] || 'inbox') || '',
      ) as Note[];
      const afterCategory = categoryFilter ? filtered.filter((note) => note.category === categoryFilter) : filtered;
      return sortNotes(afterCategory);
    },
    [notes, searchQuery, categoryFilter, groupNameById, deskState.noteGroupMap, sortNotes],
  );
  const hasActiveSearch = searchQuery.trim().length > 0 || categoryFilter !== null;
  const org = useMemo(
    () => buildOrganized(
      visibleNotes,
      deskState.groups,
      deskState.noteGroupMap || {},
      dims.w,
      activeCategory,
      hasActiveSearch,
    ),
    [visibleNotes, deskState.groups, deskState.noteGroupMap, dims.w, activeCategory, hasActiveSearch],
  );

  const positions = org.positions;
  const labels = org.labels;
  const clusterColumns = dims.w > 900 ? 3 : 2;
  const groupDropZoneWidth = Math.max((dims.w - 120) / clusterColumns - 20, 220);
  const draggedNoteGroupId = draggedNoteId
    ? (deskState.noteGroupMap?.[draggedNoteId] || 'inbox')
    : null;
  const lightweightCanvas = useMemo(() => shouldUseLightweightCanvas(visibleNotes.length), [visibleNotes.length]);

  // Calculate total height for scrolling
  const allY = Object.values(positions).map(p => p.y);
  const maxY = allY.length > 0 ? Math.max(...allY) : 0;
  const minH = Math.ceil(Math.max(labels.length, 1) / (dims.w > 900 ? 3 : 2)) * 320 + 160;
  const containerH = Math.max(maxY + CARD_H + 100, minH);

  const runImport = async (value: string) => {
    const input = value.trim();
    if (!input || state.isLoading) return;
    const draggedCard = parseDraggedCardInput(input);

    if (!canUseLocalService) {
      // 缓存状态可能是过期的（例如 App 刚启动、local-api 尚未就绪，或上一次轮询刚好超时）。
      // 导入前做一次即时健康检查，避免误报「本地服务未连接」。
      let freshOk = false;
      try {
        freshOk = (await getLocalServiceHealth()).ok;
      } catch {
        freshOk = false;
      }
      if (freshOk) {
        setServiceHealth({ ok: true, source: 'sidecar' });
      } else {
        setImportFeedback({
          phase: 'error',
          title: '本地服务未连接',
          message: '请确认 Kanbox 正在运行且未被最小化到其他桌面，稍等片刻后再拖入',
        });
        dismissImportFeedback('error');
        return;
      }
    }

    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'SET_ERROR', payload: null });
    setImportFeedback({
      phase: 'recognized',
      title: getDraggedNoteTitle(input),
      message: '已接收',
    });

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
      setImportFeedback((current) => ({
        ...current,
        phase: 'processing',
        message: draggedCard
          ? '正在匿名解析正文和媒体…'
          : '正在保存媒体并提取文字…',
      }));

      const result = await importSharedNote(input);
      setNotes(result.notes);
      setImportFeedback({
        phase: 'complete',
        title: result.note.title,
        message: result.created ? t('saved') : t('contentUpdated'),
      });
      await loadLocalStatus();
      window.setTimeout(() => {
        setImportFeedback((current) => current.phase === 'complete' ? IDLE_IMPORT_FEEDBACK : current);
      }, 1800);
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : '导入失败，请检查链接后重试';
      setImportFeedback({
        phase: 'error',
        title: '没有收录成功',
        message,
      });
      dismissImportFeedback('error', 3600);
      dispatch({ type: 'SET_ERROR', payload: message });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const handleExternalDrop = (event: DragEvent<HTMLDivElement>) => {
    if (draggedNoteId) return;
    event.preventDefault();
    event.stopPropagation();
    const input = selectDraggedNoteInput({
      custom: event.dataTransfer.getData('application/x-kanbox-note')
        || event.dataTransfer.getData('application/x-kanbox-card'),
      plain: event.dataTransfer.getData('text/plain'),
      uriList: event.dataTransfer.getData('text/uri-list'),
      mozUrl: event.dataTransfer.getData('text/x-moz-url'),
    });
    if (input.trim()) {
      void runImport(input);
    } else {
      setImportFeedback({
        phase: 'error',
        title: '没有识别到笔记',
        message: '请直接拖动小红书搜索结果里的笔记卡片或封面',
      });
      dismissImportFeedback('error');
    }
  };

  const handleCreateGroup = () => {
    setDeskState((prev) => {
      const next = createDeskGroup(prev, '新分组') as DeskState;
      const created = next.groups.find((group) => !prev.groups?.some((current) => current.id === group.id) && group.kind === 'custom');
      if (created) {
        setActiveCategory(created.id);
        setEditingGroupId(created.id);
        setEditingGroupName(created.name);
      }
      return next;
    });
  };

  const handleStartRename = (groupId: string, currentName: string) => {
    setEditingGroupId(groupId);
    setEditingGroupName(currentName);
  };

  const handleCommitRename = () => {
    if (!editingGroupId) {
      return;
    }

    setDeskState((prev) => renameDeskGroup(prev, editingGroupId, editingGroupName) as DeskState);
    setEditingGroupId(null);
    setEditingGroupName('');
  };

  const handleDeleteGroup = (groupId: string) => {
    setDeskState((prev) => deleteDeskGroup(prev, groupId) as DeskState);
    if (activeCategory === groupId) {
      setActiveCategory(null);
    }
  };

  const handleMoveNoteToGroup = (noteId: string, groupId: string) => {
    setDeskState((prev) => moveNoteToGroup(prev, noteId, groupId) as DeskState);
    setDropTargetGroupId(null);
  };

  const handleDeleteNote = async (note: Note) => {
    if (deletingNoteId) return;
    setDeletingNoteId(note.id);
    try {
      const result = await deleteStoredNote(note.id);
      setExpanded(null);
      setNotes(result.notes);
      setImportFeedback({
        phase: 'complete',
        title: note.title,
        message: '已从收藏和本地图片中删除',
      });
      dismissImportFeedback('complete', 1800);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '删除失败，请重试';
      setImportFeedback({ phase: 'error', title: '没有删除成功', message });
      dismissImportFeedback('error', 3200);
    } finally {
      setDeletingNoteId(null);
    }
  };

  const handleUpdateNote = async (noteId: string, updates: { title?: string; tags?: string[] }) => {
    try {
      const result = await updateNote(noteId, updates);
      setNotes(result.notes);
      setExpanded(result.note);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '保存失败';
      setImportFeedback({ phase: 'error', title: '没有保存成功', message });
      dismissImportFeedback('error', 3200);
    }
  };

  const handleTranscribeNote = async (noteId: string) => {
    try {
      const result = await transcribeNoteVideo(noteId);
      setNotes(result.notes);
      setExpanded(result.note);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '转写失败';
      setImportFeedback({ phase: 'error', title: '转写失败', message });
      dismissImportFeedback('error', 3200);
      throw error;
    }
  };

  const handleDragStart = (noteId: string) => {
    setDraggedNoteId(noteId);
  };

  const handleDragEnd = () => {
    setDraggedNoteId(null);
    setDropTargetGroupId(null);
  };

  // Tag management handlers
  const handleOpenTagManager = async () => {
    setShowTagManager(true);
    try {
      const tags = await getAllTags();
      setAllTags(tags);
    } catch {}
  };

  const handleRenameTag = async (oldName: string, newName: string) => {
    if (!newName.trim() || oldName === newName) { setEditingTagName(null); return; }
    try {
      const result = await renameTag(oldName, newName);
      setNotes(result.notes);
      const tags = await getAllTags();
      setAllTags(tags);
      setEditingTagName(null);
    } catch {}
  };

  const handleDeleteTag = async (tagName: string) => {
    try {
      const result = await deleteTag(tagName);
      setNotes(result.notes);
      const tags = await getAllTags();
      setAllTags(tags);
    } catch {}
  };

  // Group drag-to-reorder handlers
  const handleGroupDragStart = (groupId: string) => {
    if (groupId === 'inbox' || groupId.startsWith('auto:')) return;
    setDraggingGroupId(groupId);
  };

  const handleGroupDragOver = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    if (draggingGroupId && groupId !== draggingGroupId && !groupId.startsWith('auto:')) {
      setDragOverGroupId(groupId);
    }
  };

  const handleGroupDrop = (targetGroupId: string) => {
    if (draggingGroupId && targetGroupId !== draggingGroupId) {
      setDeskState(prev => {
        const targetIndex = prev.groups.findIndex(g => g.id === targetGroupId);
        return reorderGroup(prev, draggingGroupId, targetIndex) as DeskState;
      });
    }
    setDraggingGroupId(null);
    setDragOverGroupId(null);
  };

  const handleGroupDragEnd = () => {
    setDraggingGroupId(null);
    setDragOverGroupId(null);
  };

  const handlePasteUrlSubmit = async () => {
    if (!pasteUrl.trim() || pasteLoading) return;
    setPasteLoading(true);
    try {
      await runImport(pasteUrl);
      setPasteUrl('');
      setShowPasteInput(false);
    } catch {
      // Error is already handled in runImport
    } finally {
      setPasteLoading(false);
    }
  };

  const handlePasteInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handlePasteUrlSubmit();
    }
    if (event.key === 'Escape') {
      setPasteUrl('');
      setShowPasteInput(false);
    }
  };

  const handleExport = async () => {
    try {
      await exportNotes();
      setImportFeedback({
        phase: 'complete',
        title: '数据导出',
        message: '备份文件已开始下载',
      });
      dismissImportFeedback('complete', 2200);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '导出失败，请重试';
      setImportFeedback({ phase: 'error', title: '导出失败', message });
      dismissImportFeedback('error', 3200);
    }
  };

  const handleExportMarkdown = async () => {
    try {
      await exportNotesMarkdown();
      setImportFeedback({
        phase: 'complete',
        title: 'Markdown 导出',
        message: '文件已开始下载',
      });
      dismissImportFeedback('complete', 2200);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '导出失败，请重试';
      setImportFeedback({ phase: 'error', title: '导出失败', message });
      dismissImportFeedback('error', 3200);
    }
  };

  const handleExportHtml = async () => {
    try {
      await exportNotesHtml();
      setImportFeedback({
        phase: 'complete',
        title: 'HTML 导出',
        message: '文件已开始下载',
      });
      dismissImportFeedback('complete', 2200);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '导出失败，请重试';
      setImportFeedback({ phase: 'error', title: '导出失败', message });
      dismissImportFeedback('error', 3200);
    }
  };

  const handleOpenSettings = async () => {
    setShowSettings(true);
    try {
      const info = await getDataInfo();
      setDataInfo(info);
    } catch {}
    try {
      const settings = await getAiSettings();
      setAiSettings(settings);
      setAiDraft({
        enabled: settings.enabled,
        endpoint: settings.endpoint,
        apiKey: '',
        model: settings.model,
        autoTranscript: settings.autoTranscript,
        enhanceTranscript: settings.enhanceTranscript,
        autoPipeline: settings.autoPipeline,
        transcribeEndpoint: settings.transcribeEndpoint,
        transcribeApiKey: '',
        transcribeModel: settings.transcribeModel,
      });
    } catch {}
  };

  const handleSaveAiSettings = async () => {
    setAiSaving(true);
    setAiMessage('');
    try {
      const saved = await saveAiSettings(aiDraft);
      setAiSettings(saved);
      setAiDraft({
        enabled: saved.enabled,
        endpoint: saved.endpoint,
        apiKey: '',
        model: saved.model,
        autoTranscript: saved.autoTranscript,
        enhanceTranscript: saved.enhanceTranscript,
        autoPipeline: saved.autoPipeline,
        transcribeEndpoint: saved.transcribeEndpoint,
        transcribeApiKey: '',
        transcribeModel: saved.transcribeModel,
      });
      setAiMessage('已保存');
    } catch (error) {
      setAiMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setAiSaving(false);
    }
  };

  const handleTestAi = async () => {
    setAiTesting(true);
    setAiTestResult('idle');
    setAiMessage('');
    try {
      await testAiConnection(aiDraft);
      setAiTestResult('ok');
      setAiMessage(t('aiTestSuccess'));
    } catch (error) {
      setAiTestResult('fail');
      setAiMessage(`${t('aiTestFail')}：${error instanceof Error ? error.message : ''}`);
    } finally {
      setAiTesting(false);
    }
  };

  const handleTestTranscribe = async () => {
    setAiTranscribeTesting(true);
    setAiTranscribeTestResult('idle');
    setAiMessage('');
    try {
      await testTranscribeConnection(aiDraft);
      setAiTranscribeTestResult('ok');
      setAiMessage(t('transcribeTestSuccess'));
    } catch (error) {
      setAiTranscribeTestResult('fail');
      setAiMessage(`${t('transcribeTestFail')}：${error instanceof Error ? error.message : ''}`);
    } finally {
      setAiTranscribeTesting(false);
    }
  };

  const handleBatchProcess = async () => {
    if (batchProcessing) return;
    setBatchProcessing(true);
    try {
      const result = await batchProcessAi();
      setPipelineStatus(result.status);
      if (result.queued > 0) {
        setImportFeedback({ phase: 'complete', title: t('aiBatchQueued'), message: `${result.queued} 条` });
        dismissImportFeedback('complete', 2200);
      } else {
        setImportFeedback({ phase: 'complete', title: t('aiBatchNone'), message: t('aiBatchNone') });
        dismissImportFeedback('complete', 2200);
      }
    } catch (error) {
      setImportFeedback({ phase: 'error', title: t('aiBatchFail'), message: error instanceof Error ? error.message : '' });
      dismissImportFeedback('error', 3600);
    } finally {
      setBatchProcessing(false);
    }
  };

  const handleCheckIntegrity = async () => {
    setChecking(true);
    try {
      const result = await checkDataIntegrity();
      setIntegrityResult(result);
    } catch {
      setIntegrityResult(null);
    } finally {
      setChecking(false);
    }
  };

  const handleCreateBackup = async () => {
    setBacking(true);
    try {
      await createBackup();
      const info = await getDataInfo();
      setDataInfo(info);
      setImportFeedback({ phase: 'complete', title: '备份创建', message: '备份文件已保存到本地' });
      dismissImportFeedback('complete', 2200);
    } catch {
      setImportFeedback({ phase: 'error', title: '备份失败', message: '请重试' });
      dismissImportFeedback('error', 3200);
    } finally {
      setBacking(false);
    }
  };

  const handleRestoreBackup = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setRestoring(true);
      try {
        const result = await restoreFromBackup(file);
        setNotes(result.notes);
        setImportFeedback({
          phase: 'complete',
          title: '数据恢复',
          message: `成功导入 ${result.imported} 条笔记，跳过 ${result.skipped} 条重复`,
        });
        dismissImportFeedback('complete', 3000);
        const info = await getDataInfo();
        setDataInfo(info);
      } catch (error) {
        const message = error instanceof Error ? error.message : '恢复失败，请检查文件格式';
        setImportFeedback({ phase: 'error', title: '恢复失败', message });
        dismissImportFeedback('error', 3200);
      } finally {
        setRestoring(false);
      }
    };
    input.click();
  };

  const handleRepairNote = async (noteId: string) => {
    try {
      const result = await repairNote(noteId);
      setNotes(result.notes);
      setImportFeedback({ phase: 'complete', title: '修复完成', message: '已重新下载缺失文件' });
      dismissImportFeedback('complete', 2200);
      await handleCheckIntegrity();
    } catch {
      setImportFeedback({ phase: 'error', title: '修复失败', message: '无法重新下载文件' });
      dismissImportFeedback('error', 3200);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (isMod && e.key === 'n') {
        e.preventDefault();
        handleCreateGroup();
        return;
      }

      if (isMod && e.key === 'e') {
        e.preventDefault();
        void handleExport();
        return;
      }

      if (e.key === 'Escape') {
        if (expanded) {
          setExpanded(null);
          return;
        }
        if (showPasteInput) {
          setShowPasteInput(false);
          setPasteUrl('');
          return;
        }
        if (setupPanel) {
          setSetupPanel(null);
          return;
        }
        if (searchQuery) {
          setSearchQuery('');
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded, showPasteInput, setupPanel, searchQuery, handleCreateGroup, handleExport]);

  const canUseLocalService = serviceHealth.source === 'sidecar' && serviceHealth.ok;

  const subtitle = state.error
    ? state.error
    : state.isLoading
      ? '加载中…'
      : categoryFilter
        ? `${categoryFilter} · ${visibleNotes.length} 条`
        : hasActiveSearch
          ? `找到 ${visibleNotes.length} 条`
          : `${notes.length} 条笔记`;

  const isEmpty = notes.length === 0;
  const hasNoSearchResults = !isEmpty && hasActiveSearch && visibleNotes.length === 0;

  return (
    <div
      ref={containerRef}
      onDragEnter={(event) => {
        if (!draggedNoteId && acceptsExternalNoteDrag(event.dataTransfer.types)) {
          event.preventDefault();
          setImportFeedback({
            phase: 'dragging',
            title: t('dragToSave'),
            message: '',
          });
        }
      }}
      onDragOver={(event) => {
        if (!draggedNoteId && acceptsExternalNoteDrag(event.dataTransfer.types)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (importFeedback.phase === 'idle') {
            setImportFeedback({
              phase: 'dragging',
              title: t('dragToSave'),
              message: '',
            });
          }
        }
      }}
      onDragLeave={(event) => {
        if (draggedNoteId) return;
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setImportFeedback(IDLE_IMPORT_FEEDBACK);
      }}
      onDrop={handleExternalDrop}
      style={{
        minHeight: '100vh',
        background: '#EBE9E4',
        position: 'relative',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {/* Ambient light */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background: [
          'radial-gradient(ellipse 55% 45% at 22% 18%, rgba(217,179,102,0.09) 0%, transparent 70%)',
          'radial-gradient(ellipse 45% 55% at 82% 78%, rgba(130,153,135,0.08) 0%, transparent 70%)',
          'radial-gradient(ellipse 35% 35% at 55% 45%, rgba(204,140,115,0.05) 0%, transparent 60%)',
        ].join(', '),
      }} />

      <AnimatePresence>
        {importFeedback.phase !== 'idle' && !draggedNoteId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={handleExternalDrop}
            style={{
              position: 'fixed',
              inset: importFeedback.phase === 'dragging' ? 0 : 'auto',
              top: importFeedback.phase === 'dragging' ? 0 : 56,
              left: importFeedback.phase === 'dragging' ? 0 : '50%',
              transform: importFeedback.phase === 'dragging' ? undefined : 'translateX(-50%)',
              zIndex: 220,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: importFeedback.phase === 'dragging'
                ? 'rgba(235,233,228,0.58)'
                : 'rgba(235,233,228,0.82)',
              backdropFilter: importFeedback.phase === 'dragging' ? 'blur(5px)' : 'none',
              WebkitBackdropFilter: importFeedback.phase === 'dragging' ? 'blur(5px)' : 'none',
              pointerEvents: importFeedback.phase === 'dragging' ? 'auto' : 'none',
              boxShadow: importFeedback.phase === 'dragging'
                ? 'inset 0 0 0 2px rgba(130,153,135,0.52)'
                : 'none',
            }}
          >
            {importFeedback.phase === 'dragging' ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: [1, 1.06, 1] }}
                transition={{ opacity: { duration: 0.18 }, scale: { duration: 1.35, repeat: Infinity, ease: 'easeInOut' } }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 13, color: '#4F6254' }}
              >
                <div style={{
                  width: 72, height: 72, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(253,252,250,0.88)', border: '1px solid rgba(130,153,135,0.3)',
                  boxShadow: '0 16px 48px rgba(73,56,28,0.13)',
                }}>
                  <BookMarked size={25} strokeWidth={1.7} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em' }}>{t('dragToSave')}</span>
              </motion.div>
            ) : (
              <motion.div
                layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}
                style={{
                  maxWidth: 480, display: 'flex', alignItems: 'center', gap: 9,
                  padding: '10px 15px', borderRadius: 999,
                  color: importFeedback.phase === 'error' ? '#8F5146' : '#4F6254',
                  background: 'rgba(253,252,250,0.92)', border: '1px solid rgba(94,105,95,0.12)',
                  backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
                  boxShadow: '0 8px 28px rgba(73,56,28,0.10)',
                }}
              >
                <motion.span
                  animate={importFeedback.phase === 'processing'
                    ? { opacity: [0.35, 1, 0.35], scale: [0.82, 1, 0.82] }
                    : { opacity: 1, scale: 1 }}
                  transition={importFeedback.phase === 'processing'
                    ? { duration: 1.15, repeat: Infinity, ease: 'easeInOut' }
                    : { duration: 0.16 }}
                  style={{
                    width: 7, height: 7, flexShrink: 0, borderRadius: '50%',
                    background: importFeedback.phase === 'error' ? '#B56A5B' : '#829987',
                  }}
                />
                <div style={{
                  minWidth: 0, maxWidth: 430, fontSize: 12, fontWeight: 550,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {importFeedback.phase === 'processing'
                    ? importFeedback.message
                    : importFeedback.phase === 'complete'
                      ? `${t('saved')} · ${importFeedback.title}`
                      : importFeedback.phase === 'recognized'
                        ? '已接收'
                        : `${importFeedback.title}${importFeedback.message ? ` · ${importFeedback.message}` : ''}`}
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Header ── */}
      <header style={{
        position: 'sticky', top: 0, left: 0, right: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${12 + TITLEBAR_SAFE_TOP}px 20px 12px ${20 + TITLEBAR_SAFE_LEFT}px`,
        background: 'rgba(235,233,228,0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(0,0,0,0.04)',
      }}
      className="titlebar-drag"
      data-tauri-drag-region=""
    >
        <div style={{ width: 190, flexShrink: 0 }}>
          <h1 style={{
            fontFamily: '"Playfair Display", Georgia, serif',
            fontSize: 16, fontWeight: 600, color: '#3A3840',
            letterSpacing: '-0.015em', lineHeight: 1,
          }}>
            Kanbox
          </h1>
          <p style={{ fontSize: 10, color: '#A8A29E', marginTop: 2 }}>
            {subtitle}
          </p>
        </div>

        <div style={{
          width: 260, margin: '0 22px',
          position: 'relative', display: 'flex', alignItems: 'center',
        }}>
          <Search size={14} strokeWidth={1.8} style={{ position: 'absolute', left: 13, color: '#8F8A82', pointerEvents: 'none' }} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setActiveCategory(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearchQuery('');
            }}
            placeholder={t('search')}
            aria-label={t('search')}
            style={{
              width: '100%', height: 34, padding: '0 13px 0 36px',
              borderRadius: 13, border: '1px solid rgba(73,56,28,0.07)',
              background: 'rgba(253,252,250,0.58)',
              color: '#454248', fontSize: 12,
            }}
            className="titlebar-no-drag"
          />
        </div>

        <div style={{ display: 'flex', gap: 3, borderRadius: 8, border: '1px solid rgba(73,56,28,0.07)', overflow: 'hidden' }}>
          {([['newest', t('newest')], ['oldest', t('oldest')], ['title', t('title')]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setSortBy(key)}
              className="titlebar-no-drag"
              style={{
                padding: '0 8px', height: 28, border: 'none', fontSize: 10, cursor: 'pointer',
                background: sortBy === key ? 'rgba(130,153,135,0.12)' : 'transparent',
                color: sortBy === key ? '#4F6254' : '#9A958D',
                fontWeight: sortBy === key ? 600 : 400,
              }}>
              {label}
            </button>
          ))}
        </div>

        <button onClick={toggleBatchMode}
          className="titlebar-no-drag"
          style={{
            padding: '0 8px', height: 28, borderRadius: 8, border: batchMode ? '1px solid rgba(130,153,135,0.4)' : '1px solid rgba(73,56,28,0.07)',
            fontSize: 10, cursor: 'pointer',
            background: batchMode ? 'rgba(130,153,135,0.12)' : 'transparent',
            color: batchMode ? '#4F6254' : '#9A958D',
            fontWeight: batchMode ? 600 : 400,
          }}>
          {t('batchMode')}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {([
            ['extension', t('plugin'), Puzzle],
            ['agent', 'Agent', Bot],
          ] as const).map(([panel, label, Icon]) => (
            <motion.button
              key={panel}
              whileHover={{ y: -1, scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => void openSetupPanel(panel)}
              style={{
                height: 36, padding: '0 13px', borderRadius: 15,
                border: '1px solid rgba(73,56,28,0.07)',
                background: 'rgba(253,252,250,0.78)', color: '#666159',
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
                boxShadow: '0 3px 13px rgba(73,56,28,0.045)',
              }}
              className="titlebar-no-drag"
            >
              <Icon size={14} strokeWidth={1.8} />
              {label}
            </motion.button>
          ))}
          <motion.button
            whileHover={{ y: -1, scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => void handleExport()}
            style={{
              height: 36, padding: '0 13px', borderRadius: 15,
              border: '1px solid rgba(73,56,28,0.07)',
              background: 'rgba(253,252,250,0.78)', color: '#666159',
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
              boxShadow: '0 3px 13px rgba(73,56,28,0.045)',
            }}
            className="titlebar-no-drag"
          >
            <Download size={14} strokeWidth={1.8} />
            {t('export')}
          </motion.button>
          <motion.button
            whileHover={{ y: -1, scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => void handleOpenTagManager()}
            style={{
              height: 36, padding: '0 13px', borderRadius: 15,
              border: '1px solid rgba(73,56,28,0.07)',
              background: 'rgba(253,252,250,0.78)', color: '#666159',
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
              boxShadow: '0 3px 13px rgba(73,56,28,0.045)',
            }}
            className="titlebar-no-drag"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
              <line x1="7" y1="7" x2="7.01" y2="7"></line>
            </svg>
            {t('tags')}
          </motion.button>
          <motion.button
            whileHover={{ y: -1, scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => void handleBatchProcess()}
            disabled={batchProcessing || pipelineStatus.running}
            title={t('aiBatchProcessDesc')}
            style={{
              height: 36, padding: '0 13px', borderRadius: 15,
              border: '1px solid rgba(73,56,28,0.07)',
              background: 'rgba(253,252,250,0.78)', color: '#666159',
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11.5, fontWeight: 550, cursor: batchProcessing || pipelineStatus.running ? 'default' : 'pointer',
              boxShadow: '0 3px 13px rgba(73,56,28,0.045)',
              opacity: batchProcessing || pipelineStatus.running ? 0.6 : 1,
            }}
            className="titlebar-no-drag"
          >
            {pipelineStatus.running ? (
              <Loader2 size={14} strokeWidth={1.8} className="animate-spin" />
            ) : (
              <Sparkles size={14} strokeWidth={1.8} />
            )}
            {pipelineStatus.running && pipelineStatus.totalCount > 0
              ? `${t('aiProcessingProgress')} ${pipelineStatus.doneCount}/${pipelineStatus.totalCount}`
              : t('aiBatchProcess')}
          </motion.button>
          <motion.button
            whileHover={{ y: -1, scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => void handleOpenSettings()}
            style={{
              height: 36, padding: '0 13px', borderRadius: 15,
              border: '1px solid rgba(73,56,28,0.07)',
              background: 'rgba(253,252,250,0.78)', color: '#666159',
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11.5, fontWeight: 550, cursor: 'pointer',
              boxShadow: '0 3px 13px rgba(73,56,28,0.045)',
            }}
            className="titlebar-no-drag"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
            {t('settings')}
          </motion.button>
        </div>
      </header>

      <AnimatePresence>
        {setupPanel && (
          <SetupDialog
            panel={setupPanel}
            info={setupInfo}
            loading={setupLoading}
            message={setupMessage}
            connectingClient={connectingClient}
            connectedClients={connectedClients}
            onClose={() => setSetupPanel(null)}
            onOpenExtension={() => void handleOpenExtensionSetup()}
            onConnectAgent={(client) => void handleConnectAgent(client)}
          />
        )}
      </AnimatePresence>

      {/* Tag Manager Panel */}
      <AnimatePresence>
        {showTagManager && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowTagManager(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 310,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 28, background: 'rgba(73, 67, 57, 0.18)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              onClick={e => e.stopPropagation()}
              style={{
                width: 'min(440px, calc(100vw - 48px))', maxHeight: '70vh',
                borderRadius: 24, background: 'rgba(253,252,250,0.98)',
                border: '1px solid rgba(255,255,255,0.72)',
                boxShadow: '0 34px 90px rgba(73,56,28,0.2)',
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
              }}
            >
              <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0, color: '#3A3840', fontFamily: '"Playfair Display", Georgia, serif', fontSize: 19, fontWeight: 600 }}>
                  {t('tagManager')}
                </h2>
                <button onClick={() => setShowTagManager(false)} style={{ width: 32, height: 32, borderRadius: 999, border: '1px solid rgba(0,0,0,0.06)', background: '#F4F2ED', color: '#6F6B64', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={15} />
                </button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
                {allTags.length === 0 ? (
                  <p style={{ textAlign: 'center', color: '#9A958D', fontSize: 12, padding: '24px 0' }}>{t('noTags')}</p>
                ) : (
                  allTags.map(tag => (
                    <div key={tag.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                      {editingTagName === tag.name ? (
                        <>
                          <input value={tagEditDraft} onChange={e => setTagEditDraft(e.target.value)}
                            autoFocus onFocus={() => setTimeout(() => {}, 0)}
                            onKeyDown={e => { if (e.key === 'Enter') void handleRenameTag(tag.name, tagEditDraft); if (e.key === 'Escape') setEditingTagName(null); }}
                            onBlur={() => void handleRenameTag(tag.name, tagEditDraft)}
                            style={{ flex: 1, height: 30, border: '1px solid rgba(130,153,135,0.3)', borderRadius: 8, padding: '0 8px', fontSize: 12, outline: 'none' }}
                          />
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1, fontSize: 12, color: '#3A3840' }}>#{tag.name}</span>
                          <span style={{ fontSize: 10, color: '#9A958D', minWidth: 30, textAlign: 'right' }}>{tag.count}</span>
                          <button onClick={() => { setEditingTagName(tag.name); setTagEditDraft(tag.name); }}
                            style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', color: '#8D8881', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Pencil size={12} />
                          </button>
                          <button onClick={() => void handleDeleteTag(tag.name)}
                            style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', color: '#B56A5B', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Category filter chips ── */}
      {categories.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6,
          padding: '0 20px 10px',
          paddingLeft: `${20 + TITLEBAR_SAFE_LEFT}px`,
          position: 'relative', zIndex: 99,
        }}>
          <button
            type="button"
            onClick={() => setCategoryFilter(null)}
            className="titlebar-no-drag"
            style={{
              padding: '4px 10px', borderRadius: 999, border: 'none',
              background: categoryFilter === null ? '#829987' : 'rgba(253,252,250,0.78)',
              color: categoryFilter === null ? '#fff' : '#666159',
              fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
              boxShadow: categoryFilter === null ? '0 2px 8px rgba(55,45,25,0.08)' : 'none',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {t('all')}
          </button>
          {categories.map((cat) => {
            const c = catColor(cat);
            const isActive = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(isActive ? null : cat)}
                className="titlebar-no-drag"
                style={{
                  padding: '4px 10px', borderRadius: 999, border: 'none',
                  background: isActive ? c : 'rgba(253,252,250,0.78)',
                  color: isActive ? '#fff' : '#666159',
                  fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                  boxShadow: isActive ? `0 2px 8px ${c}30` : 'none',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Desk canvas ── */}
      <div
        ref={canvasRef}
        onScroll={(e) => {
          const target = e.currentTarget;
          setScrollY(target.scrollTop);
        }}
        style={{
        position: 'relative',
        width: '100%',
        height: isEmpty || hasNoSearchResults ? 'calc(100vh - 98px)' : containerH,
        minHeight: isEmpty || hasNoSearchResults ? 520 : undefined,
        zIndex: 1,
      }}>
        {isEmpty && !state.isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#77736C',
              textAlign: 'center',
              pointerEvents: 'none',
            }}
          >
            <BookMarked size={26} strokeWidth={1.4} color="#829987" />
            <div style={{
              marginTop: 12,
              fontFamily: '"Playfair Display", Georgia, serif',
              fontSize: 22,
              fontWeight: 600,
              color: '#4B494F',
            }}>
              {t('emptyState')}
            </div>
            <div style={{ marginTop: 7, fontSize: 12 }}>
              {t('emptyHint')}
            </div>
          </motion.div>
        )}
        {hasNoSearchResults && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              color: '#77736C', textAlign: 'center', pointerEvents: 'none',
            }}
          >
            <Search size={24} strokeWidth={1.4} color="#829987" />
            <div style={{
              marginTop: 12, fontFamily: '"Playfair Display", Georgia, serif',
              fontSize: 20, fontWeight: 600, color: '#4B494F',
            }}>
              {t('noResults')}
            </div>
          </motion.div>
        )}
        <AnimatePresence>
          {draggedNoteId && labels
            .filter(({ groupId }) => groupId !== draggedNoteGroupId)
            .map(({ groupId, x, y, color }) => {
              const isDropTarget = dropTargetGroupId === groupId;
              return (
                <motion.div
                  key={`drop-zone-${groupId}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDropTargetGroupId(groupId);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (dropTargetGroupId !== groupId) setDropTargetGroupId(groupId);
                  }}
                  onDragLeave={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                    if (dropTargetGroupId === groupId) setDropTargetGroupId(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleMoveNoteToGroup(draggedNoteId, groupId);
                    setDraggedNoteId(null);
                  }}
                  style={{
                    position: 'absolute',
                    left: x + 30 - groupDropZoneWidth / 2,
                    top: y - 14,
                    width: groupDropZoneWidth,
                    height: 330,
                    zIndex: 550,
                    borderRadius: 30,
                    border: `1px dashed ${isDropTarget ? `${color}88` : 'rgba(130,153,135,0.25)'}`,
                    background: isDropTarget ? `${color}12` : 'rgba(253,252,250,0.04)',
                    boxShadow: isDropTarget ? `inset 0 0 0 1px ${color}18` : 'none',
                    pointerEvents: 'auto',
                  }}
                />
              );
            })}
        </AnimatePresence>
        <AnimatePresence>
          {labels.map(({ groupId, name, x, y, color, kind, noteCount }) => {
            const isExpanded = activeCategory === groupId;
            const isEditing = editingGroupId === groupId;
            const isDropTarget = dropTargetGroupId === groupId;
            return (
              <motion.div
                key={`lbl-${groupId}`}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                transition={{ duration: 0.3 }}
                draggable={kind === 'custom'}
                onDragStart={() => handleGroupDragStart(groupId)}
                onDragOver={(e) => handleGroupDragOver(e, groupId)}
                onDrop={() => handleGroupDrop(groupId)}
                onDragEnd={handleGroupDragEnd}
                style={{
                  position: 'absolute',
                  left: x,
                  top: y,
                  transform: 'translateX(-50%)',
                  zIndex: isExpanded ? 600 : (activeCategory === null ? 400 : 100),
                  opacity: draggingGroupId === groupId ? 0.5 : 1,
                  outline: dragOverGroupId === groupId ? `2px dashed ${color}` : 'none',
                }}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <motion.div
                    onClick={() => {
                      if (isEditing) return;
                      setActiveCategory((prev) => (prev === groupId ? null : groupId));
                    }}
                    onDragOver={(event) => {
                      if (!draggedNoteId) return;
                      event.preventDefault();
                      if (dropTargetGroupId !== groupId) {
                        setDropTargetGroupId(groupId);
                      }
                    }}
                    onDragLeave={() => {
                      if (dropTargetGroupId === groupId) {
                        setDropTargetGroupId(null);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedNoteId) {
                        handleMoveNoteToGroup(draggedNoteId, groupId);
                      }
                      setDraggedNoteId(null);
                    }}
                    style={{
                      background: isExpanded || isDropTarget ? 'rgba(253, 252, 250, 0.98)' : 'rgba(240, 238, 230, 0.85)',
                      backdropFilter: 'blur(8px)',
                      WebkitBackdropFilter: 'blur(8px)',
                      padding: '6px 14px 6px 18px',
                      borderRadius: 24,
                      border: isExpanded || isDropTarget ? `1px solid ${color}40` : '1px solid rgba(0,0,0,0.04)',
                      boxShadow: isExpanded || isDropTarget
                        ? `0 8px 24px ${color}25, 0 2px 8px rgba(0,0,0,0.06)`
                        : '0 2px 8px rgba(55,45,25,0.08)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    animate={isDropTarget ? { scale: 1.05, y: -2 } : { scale: 1, y: 0 }}
                    whileHover={{ scale: 1.05, y: -2 }}
                    whileTap={{ scale: 0.96 }}
                  >
                    {isEditing ? (
                      <>
                        <input
                          value={editingGroupName}
                          onChange={(event) => setEditingGroupName(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              handleCommitRename();
                            }
                            if (event.key === 'Escape') {
                              setEditingGroupId(null);
                              setEditingGroupName('');
                            }
                          }}
                          autoFocus
                          style={{
                            width: 132,
                            height: 30,
                            border: '1px solid rgba(0,0,0,0.08)',
                            borderRadius: 10,
                            background: '#fff',
                            padding: '0 10px',
                            fontSize: 13,
                            color: '#3A3840',
                            outline: 'none',
                          }}
                        />
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCommitRename();
                          }}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            border: 'none',
                            background: color,
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                          }}
                        >
                          <Check size={13} strokeWidth={2.2} />
                        </button>
                      </>
                    ) : (
                      <>
                        <div>
                          <div style={{ position: 'relative', fontFamily: 'Playfair Display, Georgia, serif', fontSize: 15, fontWeight: 600, color: isExpanded ? color : '#3A3840', zIndex: 1 }}>
                            {name}
                            <div style={{
                              position: 'absolute',
                              bottom: 2,
                              left: -2,
                              right: -2,
                              height: 6,
                              background: color,
                              opacity: isExpanded ? 0.1 : 0.35,
                              zIndex: -1,
                              borderRadius: 2,
                              transition: 'opacity 0.3s ease',
                            }} />
                          </div>
                          <div style={{ marginTop: 2, fontSize: 10, color: '#A8A29E', lineHeight: 1 }}>
                            {kind === 'inbox' ? '新进笔记' : `${noteCount} 条笔记`}
                          </div>
                        </div>
                        <motion.div
                          animate={{
                            rotate: isExpanded ? 180 : 0,
                            color: isExpanded ? color : '#A8A29E'
                          }}
                          transition={{ type: 'spring', stiffness: 250, damping: 20 }}
                          style={{ display: 'flex', alignItems: 'center' }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                        </motion.div>
                      </>
                    )}
                  </motion.div>

                  <AnimatePresence>
                    {isExpanded && (
                      <>
                        <motion.button
                          initial={{ opacity: 0, scale: 0.8, x: -10 }}
                          animate={{ opacity: 1, scale: 1, x: 0 }}
                          exit={{ opacity: 0, scale: 0.8, x: -10 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleStartRename(groupId, name);
                          }}
                          style={{
                            background: 'rgba(253,252,250,0.94)',
                            color: '#6B6860',
                            border: '1px solid rgba(0,0,0,0.06)',
                            borderRadius: 20,
                            width: 34,
                            height: 34,
                            cursor: 'pointer',
                            boxShadow: '0 4px 12px rgba(73,56,28,0.08)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                        >
                          <Pencil size={14} strokeWidth={1.8} />
                        </motion.button>
                        {kind === 'custom' && (
                          <motion.button
                            initial={{ opacity: 0, scale: 0.8, x: -10 }}
                            animate={{ opacity: 1, scale: 1, x: 0 }}
                            exit={{ opacity: 0, scale: 0.8, x: -10 }}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDeleteGroup(groupId);
                            }}
                            style={{
                              background: 'rgba(253,252,250,0.94)',
                              color: '#B56A5B',
                              border: '1px solid rgba(181,106,91,0.18)',
                              borderRadius: 20,
                              width: 34,
                              height: 34,
                              cursor: 'pointer',
                              boxShadow: '0 4px 12px rgba(73,56,28,0.08)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                          >
                            <Trash2 size={14} strokeWidth={1.8} />
                          </motion.button>
                        )}
                      </>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Cards */}
        {visibleNotes.map(note => {
          const pos = positions[note.id];
          if (!pos) return null;
          const noteGroupId = deskState.noteGroupMap?.[note.id] || 'inbox';
          const isDimmed = activeCategory !== null && noteGroupId !== activeCategory;

          // Virtual rendering: skip cards far outside viewport
          const viewTop = scrollY - 200;
          const viewBottom = scrollY + dims.h + 200;
          if (pos.y < viewTop || pos.y > viewBottom) return null;

          return (
            <DeskCard
              key={note.id}
              note={note}
              pos={pos}
              isDimmed={isDimmed}
              lightweight={lightweightCanvas || visibleNotes.length > 30}
              onClick={() => setExpanded(note)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              batchMode={batchMode}
              isSelected={selectedNoteIds.has(note.id)}
              onToggleSelect={() => toggleNoteSelection(note.id)}
            />
          );
        })}
      </div>

      {/* ── Expanded overlay ── */}
      <AnimatePresence>
        {expanded && (
          <ExpandedCard
            key={expanded.id}
            note={expanded}
            onClose={() => setExpanded(null)}
            onDelete={() => void handleDeleteNote(expanded)}
            onUpdate={(updates) => void handleUpdateNote(expanded.id, updates)}
            onTranscribe={() => handleTranscribeNote(expanded.id)}
            onNoteChanged={(updatedNote) => {
              setExpanded(updatedNote);
              setNotes(notes.map((n) => (n.id === updatedNote.id ? updatedNote : n)));
            }}
            isDeleting={deletingNoteId === expanded.id}
          />
        )}
      </AnimatePresence>

      {/* ── Bottom floating controls ── */}
      {!state.isLoading && notes.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            position: 'fixed',
            bottom: 24,
            left: 0,
            right: 0,
            zIndex: 90,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            pointerEvents: 'none',
          }}
        >
          <AnimatePresence>
            {showPasteInput && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  pointerEvents: 'auto',
                }}
              >
                <div style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                }}>
                  <Link size={14} strokeWidth={1.8} style={{
                    position: 'absolute',
                    left: 13,
                    color: '#8F8A82',
                    pointerEvents: 'none',
                  }} />
                  <input
                    value={pasteUrl}
                    onChange={(e) => setPasteUrl(e.target.value)}
                    onKeyDown={handlePasteInputKeyDown}
                    placeholder={t('pasteLinkPlaceholder')}
                    autoFocus
                    style={{
                      width: 320,
                      height: 40,
                      padding: '0 36px 0 36px',
                      borderRadius: 20,
                      border: '1px solid rgba(73,56,28,0.07)',
                      background: 'rgba(253,252,250,0.95)',
                      color: '#454248',
                      fontSize: 13,
                      backdropFilter: 'blur(10px)',
                      WebkitBackdropFilter: 'blur(10px)',
                      boxShadow: '0 4px 20px rgba(55,45,25,0.12), 0 2px 8px rgba(0,0,0,0.08)',
                    }}
                  />
                  <button
                    onClick={() => {
                      setPasteUrl('');
                      setShowPasteInput(false);
                    }}
                    style={{
                      position: 'absolute',
                      right: 8,
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(0,0,0,0.06)',
                      color: '#8F8A82',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => void handlePasteUrlSubmit()}
                  disabled={pasteLoading || !pasteUrl.trim()}
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    border: 'none',
                    background: pasteUrl.trim() ? '#829987' : '#C8C7C2',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: pasteUrl.trim() ? 'pointer' : 'default',
                    boxShadow: '0 4px 20px rgba(55,45,25,0.12), 0 2px 8px rgba(0,0,0,0.08)',
                    opacity: pasteLoading ? 0.7 : 1,
                  }}
                >
                  {pasteLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                      <polyline points="12 5 19 12 12 19"></polyline>
                    </svg>
                  )}
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>

          <div style={{
            display: 'flex',
            gap: 10,
            pointerEvents: 'auto',
          }}>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowPasteInput((prev) => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 500,
                color: showPasteInput ? '#829987' : '#666159',
                background: showPasteInput ? 'rgba(130,153,135,0.1)' : 'rgba(253,252,250,0.95)',
                border: showPasteInput ? '1px solid rgba(130,153,135,0.3)' : '1px solid rgba(73,56,28,0.07)',
                borderRadius: 24,
                padding: '10px 20px',
                cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(55,45,25,0.12), 0 2px 8px rgba(0,0,0,0.08)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              <Link size={16} />
              {t('pasteLink')}
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleCreateGroup}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 500,
                color: '#FDFCFA',
                background: '#829987',
                border: '1px solid #829987',
                borderRadius: 24,
                padding: '10px 20px',
                cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(55,45,25,0.12), 0 2px 8px rgba(0,0,0,0.08)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              <Plus size={16} />
              {t('newGroup')}
            </motion.button>
          </div>
        </motion.div>
      )}

      {/* ── Batch action bar ── */}
      <AnimatePresence>
        {batchMode && selectedNoteIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            style={{
              position: 'fixed',
              bottom: 24,
              left: 0,
              right: 0,
              zIndex: 100,
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 20px',
              borderRadius: 20,
              background: 'rgba(253,252,250,0.95)',
              border: '1px solid rgba(73,56,28,0.08)',
              boxShadow: '0 8px 32px rgba(55,45,25,0.15)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              pointerEvents: 'auto',
            }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: '#454248' }}>
                已选 {selectedNoteIds.size} 条
              </span>
              <button onClick={async () => {
                const ids = Array.from(selectedNoteIds);
                for (const id of ids) {
                  try {
                    await deleteStoredNote(id);
                  } catch { /* ignore */ }
                }
                const result = await getNotes();
                setNotes(result);
                setSelectedNoteIds(new Set());
                setBatchMode(false);
              }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 36, padding: '0 14px', borderRadius: 12,
                  border: 'none', background: 'rgba(181,106,91,0.12)',
                  color: '#A85F52', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>
                <Trash2 size={14} strokeWidth={1.8} />
                {t('deleteSelected')}
              </button>
              <button onClick={() => {
                setBatchMode(false);
                setSelectedNoteIds(new Set());
              }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 36, padding: '0 14px', borderRadius: 12,
                  border: '1px solid rgba(73,56,28,0.08)', background: 'transparent',
                  color: '#666159', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                }}>
                {t('exitBatchMode')}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setShowSettings(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 310,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 28, background: 'rgba(73, 67, 57, 0.18)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              willChange: 'opacity',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              transition={{ duration: 0.15 }}
              onClick={e => e.stopPropagation()}
              style={{
                width: 'min(520px, calc(100vw - 48px))',
                maxHeight: '80vh',
                borderRadius: 24,
                background: 'rgba(253,252,250,0.98)',
                border: '1px solid rgba(255,255,255,0.72)',
                boxShadow: '0 34px 90px rgba(73,56,28,0.2)',
                overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
                willChange: 'transform, opacity',
              }}
            >
              {/* Header */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0, color: '#3A3840', fontFamily: '"Playfair Display", Georgia, serif', fontSize: 19, fontWeight: 600 }}>
                  {t('settings')}
                </h2>
                <button onClick={() => setShowSettings(false)} style={{ width: 32, height: 32, borderRadius: 999, border: '1px solid rgba(0,0,0,0.06)', background: '#F4F2ED', color: '#6F6B64', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={15} />
                </button>
              </div>

              {/* Content */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {/* Data Info */}
                <div style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: '#3A3840', marginBottom: 12 }}>{t('dataStats')}</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div style={{ padding: '12px', borderRadius: 10, background: 'rgba(130,153,135,0.06)' }}>
                      <div style={{ fontSize: 20, fontWeight: 600, color: '#3A3840' }}>{dataInfo?.notesCount ?? '-'}</div>
                      <div style={{ fontSize: 10, color: '#9A958D' }}>{t('totalNotes')}</div>
                    </div>
                    <div style={{ padding: '12px', borderRadius: 10, background: 'rgba(130,153,135,0.06)' }}>
                      <div style={{ fontSize: 20, fontWeight: 600, color: '#3A3840' }}>{dataInfo ? formatBytes(dataInfo.mediaSize) : '-'}</div>
                      <div style={{ fontSize: 10, color: '#9A958D' }}>{t('mediaFiles')}</div>
                    </div>
                    <div style={{ padding: '12px', borderRadius: 10, background: 'rgba(130,153,135,0.06)' }}>
                      <div style={{ fontSize: 20, fontWeight: 600, color: '#3A3840' }}>{dataInfo?.backupCount ?? 0}</div>
                      <div style={{ fontSize: 10, color: '#9A958D' }}>{t('backups')}</div>
                    </div>
                    <div style={{ padding: '12px', borderRadius: 10, background: 'rgba(130,153,135,0.06)' }}>
                      <div style={{ fontSize: 11, color: '#5E5A54', wordBreak: 'break-all' }}>{dataInfo?.dataDirectory ?? '-'}</div>
                      <div style={{ fontSize: 10, color: '#9A958D', marginTop: 4 }}>{t('dataDir')}</div>
                    </div>
                  </div>
                </div>

                {/* Backup */}
                <div style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: '#3A3840', marginBottom: 12 }}>{t('backupRestore')}</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <button onClick={() => void handleCreateBackup()} disabled={backing}
                      style={{ height: 36, borderRadius: 10, border: 'none', background: '#829987', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      JSON 备份
                    </button>
                    <button onClick={() => void handleExportMarkdown()}
                      style={{ height: 36, borderRadius: 10, border: '1px solid rgba(73,56,28,0.07)', background: 'rgba(253,252,250,0.78)', color: '#666159', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Markdown
                    </button>
                    <button onClick={() => void handleExportHtml()}
                      style={{ height: 36, borderRadius: 10, border: '1px solid rgba(73,56,28,0.07)', background: 'rgba(253,252,250,0.78)', color: '#666159', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      HTML
                    </button>
                    <button onClick={() => void handleRestoreBackup()} disabled={restoring}
                      style={{ height: 36, borderRadius: 10, border: '1px solid rgba(73,56,28,0.07)', background: 'rgba(253,252,250,0.78)', color: '#666159', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {t('restoreBackup')}
                    </button>
                  </div>
                  <p style={{ fontSize: 10, color: '#9A958D', marginTop: 6, textAlign: 'center' }}>
                    选择 .json 备份文件恢复数据（不覆盖已有笔记）
                  </p>
                </div>

                {/* Data Integrity */}
                <div>
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: '#3A3840', marginBottom: 12 }}>{t('integrity')}</h3>
                  <button onClick={() => void handleCheckIntegrity()} disabled={checking} style={{ width: '100%', height: 40, borderRadius: 10, border: '1px solid rgba(73,56,28,0.07)', background: 'rgba(253,252,250,0.78)', color: '#666159', fontSize: 12, fontWeight: 600, cursor: checking ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 12 }}>
                    {checking ? <Loader2 size={14} className="animate-spin" /> : null}
                    {checking ? t('checking') : t('checkIntegrity')}
                  </button>

                  {integrityResult && (
                    <div style={{ padding: '12px', borderRadius: 10, background: integrityResult.brokenNotes.length === 0 ? 'rgba(130,153,135,0.06)' : 'rgba(181,106,91,0.06)' }}>
                      <div style={{ fontSize: 12, color: '#3A3840', marginBottom: 8 }}>
                        {integrityResult.brokenNotes.length === 0
                          ? `✓ 全部 ${integrityResult.totalNotes} 条笔记数据完整`
                          : `${integrityResult.brokenNotes.length} 条笔记有缺失文件`}
                      </div>
                      {integrityResult.brokenNotes.map(note => (
                        <div key={note.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid rgba(0,0,0,0.04)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: '#5E5A54', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note.title}</div>
                            <div style={{ fontSize: 9, color: '#B56A5B' }}>{note.missingFiles.length} 个文件缺失</div>
                          </div>
                          <button onClick={() => void handleRepairNote(note.id)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(130,153,135,0.12)', color: '#4F6254', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>
                            修复
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* AI Settings */}
                <div style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: '#3A3840', marginBottom: 12 }}>{t('aiSettings')}</h3>

                  {/* 音转文字 */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#5E5A54' }}>{t('transcribeSettings')}</span>
                      <button
                        type="button"
                        onClick={() => setAiDraft(d => ({ ...d, autoTranscript: !d.autoTranscript }))}
                        style={{
                          width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative',
                          background: aiDraft.autoTranscript ? '#829987' : '#D8D5CF', transition: 'background 0.15s',
                        }}>
                        <span style={{
                          position: 'absolute', top: 2, left: aiDraft.autoTranscript ? 20 : 2,
                          width: 18, height: 18, borderRadius: '50%', background: '#fff',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                        }} />
                      </button>
                    </div>
                    <p style={{ margin: 0, fontSize: 10.5, color: '#9A958D' }}>{t('autoTranscriptDesc')}</p>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '12px 0 4px' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#5E5A54' }}>{t('transcriptEnhance')}</span>
                      <button
                        type="button"
                        onClick={() => setAiDraft(d => ({ ...d, enhanceTranscript: !d.enhanceTranscript }))}
                        style={{
                          width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative',
                          background: aiDraft.enhanceTranscript ? '#5E7FA3' : '#D8D5CF', transition: 'background 0.15s',
                        }}>
                        <span style={{
                          position: 'absolute', top: 2, left: aiDraft.enhanceTranscript ? 20 : 2,
                          width: 18, height: 18, borderRadius: '50%', background: '#fff',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                        }} />
                      </button>
                    </div>
                    <p style={{ margin: 0, fontSize: 10.5, color: '#9A958D' }}>{t('transcriptEnhanceDesc')}</p>

                    {aiDraft.enhanceTranscript && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(94,127,163,0.04)', border: '1px solid rgba(94,127,163,0.12)' }}>
                        <label style={{ fontSize: 10.5, color: '#8C8780' }}>
                          {t('transcribeEndpoint')}
                          <input
                            type="text"
                            value={aiDraft.transcribeEndpoint}
                            onChange={(e) => setAiDraft(d => ({ ...d, transcribeEndpoint: e.target.value }))}
                            placeholder={t('transcribeEndpointPlaceholder')}
                            style={{
                              marginTop: 4, width: '100%', height: 34, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
                              background: '#F7F5F0', padding: '0 10px', fontSize: 12, color: '#3A3840', boxSizing: 'border-box',
                            }}
                          />
                        </label>
                        <label style={{ fontSize: 10.5, color: '#8C8780' }}>
                          {t('transcribeApiKey')}
                          <div style={{ position: 'relative', marginTop: 4 }}>
                            <input
                              type={showTranscribeApiKey ? 'text' : 'password'}
                              value={aiDraft.transcribeApiKey}
                              onChange={(e) => setAiDraft(d => ({ ...d, transcribeApiKey: e.target.value }))}
                              placeholder={aiSettings?.transcribeApiKeySet ? t('aiApiKeyPlaceholder') : t('transcribeApiKeyPlaceholder')}
                              style={{
                                width: '100%', height: 34, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
                                background: '#F7F5F0', padding: '0 34px 0 10px', fontSize: 12, color: '#3A3840', boxSizing: 'border-box',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setShowTranscribeApiKey(v => !v)}
                              title={showTranscribeApiKey ? '隐藏密钥' : '显示密钥'}
                              style={{ position: 'absolute', top: 0, right: 0, width: 34, height: 34, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: '#8C8780' }}
                            >
                              {showTranscribeApiKey ? '🙈' : '👁'}
                            </button>
                          </div>
                        </label>
                        <label style={{ fontSize: 10.5, color: '#8C8780' }}>
                          {t('transcribeModel')}
                          <input
                            type="text"
                            value={aiDraft.transcribeModel}
                            onChange={(e) => setAiDraft(d => ({ ...d, transcribeModel: e.target.value }))}
                            placeholder={t('transcribeModelPlaceholder')}
                            style={{
                              marginTop: 4, width: '100%', height: 34, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
                              background: '#F7F5F0', padding: '0 10px', fontSize: 12, color: '#3A3840', boxSizing: 'border-box',
                            }}
                          />
                        </label>
                        <button type="button" onClick={() => void handleTestTranscribe()} disabled={aiTranscribeTesting}
                          style={{
                            alignSelf: 'flex-start', height: 30, padding: '0 12px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                            border: '1px solid rgba(94,127,163,0.25)', cursor: aiTranscribeTesting ? 'default' : 'pointer',
                            background: aiTranscribeTestResult === 'ok' ? 'rgba(79,98,84,0.1)'
                              : aiTranscribeTestResult === 'fail' ? 'rgba(181,106,91,0.12)' : 'rgba(253,252,250,0.78)',
                            color: aiTranscribeTestResult === 'ok' ? '#4F6254' : aiTranscribeTestResult === 'fail' ? '#B56A5B' : '#5E7FA3',
                          }}>
                          {aiTranscribeTesting ? '测试中...' : aiTranscribeTestResult === 'ok' ? `✓ ${t('aiTest')}` : aiTranscribeTestResult === 'fail' ? `✗ ${t('aiTest')}` : t('aiTest')}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* AI 自动流水线 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 4px' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#5E5A54' }}>{t('aiAutoPipeline')}</span>
                    <button
                      type="button"
                      onClick={() => setAiDraft(d => ({ ...d, autoPipeline: !d.autoPipeline }))}
                      style={{
                        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative',
                        background: aiDraft.autoPipeline ? '#829987' : '#D8D5CF', transition: 'background 0.15s',
                      }}>
                      <span style={{
                        position: 'absolute', top: 2, left: aiDraft.autoPipeline ? 20 : 2,
                        width: 18, height: 18, borderRadius: '50%', background: '#fff',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                      }} />
                    </button>
                  </div>
                  <p style={{ margin: 0, fontSize: 10.5, color: '#9A958D' }}>{t('aiAutoPipelineDesc')}</p>

                  {/* AI 摘要 + 知识拓展 */}
                  <div style={{ paddingTop: 14, borderTop: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#5E5A54' }}>{t('aiEnable')}</span>
                      <button
                        type="button"
                        onClick={() => setAiDraft(d => ({ ...d, enabled: !d.enabled }))}
                        style={{
                          width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative',
                          background: aiDraft.enabled ? '#829987' : '#D8D5CF', transition: 'background 0.15s',
                        }}>
                        <span style={{
                          position: 'absolute', top: 2, left: aiDraft.enabled ? 20 : 2,
                          width: 18, height: 18, borderRadius: '50%', background: '#fff',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                        }} />
                      </button>
                    </div>
                    <p style={{ margin: '0 0 12px', fontSize: 10.5, color: '#9A958D' }}>{t('aiEnableDesc')}</p>

                    {aiDraft.enabled && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ fontSize: 10.5, color: '#8C8780' }}>
                          {t('aiEndpoint')}
                          <input
                            type="text"
                            value={aiDraft.endpoint}
                            onChange={(e) => setAiDraft(d => ({ ...d, endpoint: e.target.value }))}
                            placeholder="https://api.openai.com/v1"
                            style={{
                              marginTop: 4, width: '100%', height: 34, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
                              background: '#F7F5F0', padding: '0 10px', fontSize: 12, color: '#3A3840', boxSizing: 'border-box',
                            }}
                          />
                        </label>
                        <label style={{ fontSize: 10.5, color: '#8C8780' }}>
                          {t('aiApiKey')}
                          <div style={{ position: 'relative', marginTop: 4 }}>
                            <input
                              type={showApiKey ? 'text' : 'password'}
                              value={aiDraft.apiKey}
                              onChange={(e) => setAiDraft(d => ({ ...d, apiKey: e.target.value }))}
                              placeholder={aiSettings?.apiKeySet ? t('aiApiKeyPlaceholder') : 'sk-...'}
                              style={{
                                width: '100%', height: 34, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
                                background: '#F7F5F0', padding: '0 34px 0 10px', fontSize: 12, color: '#3A3840', boxSizing: 'border-box',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setShowApiKey(v => !v)}
                              title={showApiKey ? '隐藏密钥' : '显示密钥'}
                              style={{ position: 'absolute', top: 0, right: 0, width: 34, height: 34, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: '#8C8780' }}
                            >
                              {showApiKey ? '🙈' : '👁'}
                            </button>
                          </div>
                        </label>
                        <label style={{ fontSize: 10.5, color: '#8C8780' }}>
                          {t('aiModel')}
                          <input
                            type="text"
                            value={aiDraft.model}
                            onChange={(e) => setAiDraft(d => ({ ...d, model: e.target.value }))}
                            placeholder="gpt-4o-mini"
                            style={{
                              marginTop: 4, width: '100%', height: 34, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)',
                              background: '#F7F5F0', padding: '0 10px', fontSize: 12, color: '#3A3840', boxSizing: 'border-box',
                            }}
                          />
                        </label>
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button type="button" onClick={() => void handleTestAi()} disabled={aiTesting}
                        style={{
                          flex: 1, height: 34, borderRadius: 9, fontSize: 11, fontWeight: 600,
                          border: '1px solid rgba(73,56,28,0.07)', cursor: aiTesting ? 'default' : 'pointer',
                          background: aiTestResult === 'ok' ? 'rgba(79,98,84,0.1)' : aiTestResult === 'fail' ? 'rgba(181,106,91,0.12)' : 'rgba(253,252,250,0.78)',
                          color: aiTestResult === 'ok' ? '#4F6254' : aiTestResult === 'fail' ? '#B56A5B' : '#666159',
                        }}>
                        {aiTesting ? '测试中...' : aiTestResult === 'ok' ? `✓ ${t('aiTestSuccess')}` : aiTestResult === 'fail' ? `✗ ${t('aiTestFail')}` : t('aiTest')}
                      </button>
                      <button type="button" onClick={() => void handleSaveAiSettings()} disabled={aiSaving}
                        style={{ flex: 1, height: 34, borderRadius: 9, border: 'none', background: '#829987', color: '#fff', fontSize: 11, fontWeight: 600, cursor: aiSaving ? 'default' : 'pointer' }}>
                        {aiSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                    {aiMessage && (
                      <p style={{
                        margin: '8px 0 0', fontSize: 10.5, lineHeight: 1.6,
                        color: (aiTestResult === 'ok' || aiTranscribeTestResult === 'ok' || aiMessage === '已保存')
                          ? '#4F6254' : '#B56A5B',
                      }}>{aiMessage}</p>
                    )}
                  </div>
                </div>

                {/* Language */}
                <div style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 600, color: '#3A3840', marginBottom: 12 }}>{t('language')}</h3>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {getAvailableLanguages().map(lang => (
                      <button key={lang.code} onClick={() => setLanguage(lang.code)}
                        style={{
                          flex: 1, height: 36, borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          border: getLanguage() === lang.code ? `1px solid #829987` : '1px solid rgba(0,0,0,0.06)',
                          background: getLanguage() === lang.code ? '#829987' : 'transparent',
                          color: getLanguage() === lang.code ? '#fff' : '#666159',
                        }}>
                        {lang.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Onboarding Guide */}
      <AnimatePresence>
        {showOnboarding && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 500,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)',
            }}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
              style={{
                width: 420, borderRadius: 24, background: '#FDFCFA',
                padding: '36px 32px', textAlign: 'center',
                boxShadow: '0 40px 100px rgba(0,0,0,0.3)',
              }}
            >
              <div style={{ fontSize: 28, fontWeight: 600, color: '#3A3840', marginBottom: 8, fontFamily: '"Playfair Display", Georgia, serif' }}>
                {onboardingStep === 0 ? '欢迎使用 Kanbox' : onboardingStep === 1 ? '安装扩展' : '开始收藏'}
              </div>
              <p style={{ color: '#666159', fontSize: 13, lineHeight: 1.7, marginBottom: 24 }}>
                {onboardingStep === 0
                  ? '专治收藏夹吃灰——让你存过的笔记，这次真的找得回来。'
                  : onboardingStep === 1
                    ? '点击右上角「插件」按钮安装 Chrome 扩展，然后在小红书等平台拖拽或点击收藏。'
                    : '所有数据存在你的电脑上，不上传云端。支持小红书、B站、微博、抖音、知乎、快手、头条。'}
              </p>

              {/* Step indicator */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 24 }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: i === onboardingStep ? '#829987' : '#D2D0CB',
                    transition: 'background 0.2s',
                  }} />
                ))}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={dismissOnboarding}
                  style={{ flex: 1, height: 40, borderRadius: 12, border: '1px solid rgba(0,0,0,0.06)', background: 'transparent', color: '#8C8780', fontSize: 12, cursor: 'pointer' }}>
                  跳过
                </button>
                <button onClick={() => onboardingStep < 2 ? setOnboardingStep(onboardingStep + 1) : dismissOnboarding()}
                  style={{ flex: 1, height: 40, borderRadius: 12, border: 'none', background: '#829987', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {onboardingStep < 2 ? '下一步' : '开始使用'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
