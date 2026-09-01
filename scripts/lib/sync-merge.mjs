import { createHash } from 'node:crypto';

const NOTE_ID_PATTERN = /^[0-9a-f]{24}$/i;

function finiteRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

function timestampMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function noteTimestamp(note) {
  return timestampMs(note?.updatedAt || note?.savedAt);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !['revision', 'updatedAt', 'updatedBy', 'syncConflict', 'syncConflictFields'].includes(key))
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function recordFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value)) ?? 'undefined').digest('hex');
}

function isEmpty(value) {
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function earliestIso(left, right) {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (!leftMs) return right || '';
  if (!rightMs) return left || '';
  return leftMs <= rightMs ? left : right;
}

function latestIso(left, right) {
  return timestampMs(left) >= timestampMs(right) ? (left || right || '') : (right || left || '');
}

function changedFields(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return [...keys]
    .filter((key) => !['revision', 'updatedAt', 'updatedBy', 'syncConflict', 'syncConflictFields'].includes(key))
    .filter((key) => recordFingerprint(left?.[key]) !== recordFingerprint(right?.[key]))
    .sort();
}

export function stampRecord(record, { now = new Date().toISOString(), deviceId = '' } = {}) {
  return {
    ...record,
    revision: finiteRevision(record?.revision) + 1,
    updatedAt: now,
    ...(deviceId ? { updatedBy: deviceId } : {}),
  };
}

export function initializeRecord(record, { now = new Date().toISOString(), deviceId = '' } = {}) {
  return {
    ...record,
    revision: finiteRevision(record?.revision),
    updatedAt: record?.updatedAt || record?.savedAt || now,
    ...(record?.updatedBy || !deviceId ? {} : { updatedBy: deviceId }),
  };
}

export function resolveNoteConflict(record, options = {}) {
  const resolved = { ...record };
  delete resolved.syncConflict;
  delete resolved.syncConflictFields;
  return stampRecord(resolved, options);
}

export function mergeNoteRecords(localNote, incomingNote) {
  const local = initializeRecord(localNote);
  const incoming = initializeRecord(incomingNote);
  const localFingerprint = recordFingerprint(local);
  const incomingFingerprint = recordFingerprint(incoming);
  if (localFingerprint === incomingFingerprint) {
    return { note: local, decision: 'unchanged', conflict: false };
  }

  const localRevision = finiteRevision(local.revision);
  const incomingRevision = finiteRevision(incoming.revision);
  const localTime = noteTimestamp(local);
  const incomingTime = noteTimestamp(incoming);
  const divergent = localRevision === incomingRevision;
  let incomingWins;
  if (incomingRevision !== localRevision) {
    incomingWins = incomingRevision > localRevision;
  } else if (incomingTime !== localTime) {
    incomingWins = incomingTime > localTime;
  } else {
    // 完全相同的逻辑时钟发生分叉时，用内容指纹稳定决胜，保证 A 合并 B 与 B 合并 A
    // 最终选择一致，不会在两台设备之间反复覆盖。
    incomingWins = incomingFingerprint > localFingerprint;
  }

  const primary = incomingWins ? incoming : local;
  const secondary = incomingWins ? local : incoming;
  const merged = { ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    if (isEmpty(merged[key]) && !isEmpty(value)) merged[key] = value;
  }
  merged.tags = [...new Set([
    ...(Array.isArray(local.tags) ? local.tags : []),
    ...(Array.isArray(incoming.tags) ? incoming.tags : []),
  ].filter(Boolean))].sort().slice(0, 100);
  merged.savedAt = earliestIso(local.savedAt, incoming.savedAt) || primary.savedAt;
  merged.updatedAt = latestIso(local.updatedAt || local.savedAt, incoming.updatedAt || incoming.savedAt);
  merged.revision = Math.max(localRevision, incomingRevision);

  const conflictFields = divergent ? changedFields(local, incoming) : [];
  if (conflictFields.length > 0) {
    merged.syncConflict = true;
    merged.syncConflictFields = conflictFields;
  }

  return {
    note: merged,
    decision: divergent ? 'merged' : incomingWins ? 'incoming' : 'local',
    conflict: conflictFields.length > 0,
  };
}

export function mergeNoteCollections(localNotes, incomingNotes) {
  const notes = Array.isArray(localNotes) ? [...localNotes] : [];
  const indexById = new Map(
    notes
      .map((note, index) => [String(note?.id || '').toLowerCase(), index])
      .filter(([id]) => NOTE_ID_PATTERN.test(id)),
  );
  const decisions = new Map();
  const stats = { added: 0, updated: 0, kept: 0, unchanged: 0, conflicts: 0, invalid: 0 };

  for (const rawIncoming of Array.isArray(incomingNotes) ? incomingNotes : []) {
    const id = String(rawIncoming?.id || '').toLowerCase();
    if (!NOTE_ID_PATTERN.test(id)) {
      stats.invalid += 1;
      continue;
    }
    const incoming = initializeRecord({ ...rawIncoming, id });
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, notes.length);
      notes.push(incoming);
      decisions.set(id, 'incoming');
      stats.added += 1;
      continue;
    }

    const result = mergeNoteRecords(notes[existingIndex], incoming);
    notes[existingIndex] = result.note;
    decisions.set(id, result.decision);
    if (result.conflict) stats.conflicts += 1;
    if (result.decision === 'incoming' || result.decision === 'merged') stats.updated += 1;
    else if (result.decision === 'local') stats.kept += 1;
    else stats.unchanged += 1;
  }

  return { notes, decisions, stats };
}

export function mergeWorkspaceRecords(localWorkspace, incomingWorkspace) {
  const local = localWorkspace && typeof localWorkspace === 'object' ? localWorkspace : {};
  const incoming = incomingWorkspace && typeof incomingWorkspace === 'object' ? incomingWorkspace : {};
  const localRevision = finiteRevision(local.revision);
  const incomingRevision = finiteRevision(incoming.revision);
  const localTime = timestampMs(local.updatedAt);
  const incomingTime = timestampMs(incoming.updatedAt);
  const incomingWins = incomingRevision !== localRevision
    ? incomingRevision > localRevision
    : incomingTime !== localTime
      ? incomingTime > localTime
      : recordFingerprint(incoming) > recordFingerprint(local);
  const primary = incomingWins ? incoming : local;
  const secondary = incomingWins ? local : incoming;
  const groups = [];
  const seenGroupIds = new Set();
  for (const group of [...(primary.groups || []), ...(secondary.groups || [])]) {
    if (!group || typeof group.id !== 'string' || seenGroupIds.has(group.id)) continue;
    seenGroupIds.add(group.id);
    groups.push(group);
  }

  return {
    groups,
    noteGroupMap: { ...(secondary.noteGroupMap || {}), ...(primary.noteGroupMap || {}) },
    knownNoteIds: [...new Set([...(primary.knownNoteIds || []), ...(secondary.knownNoteIds || [])])],
    revision: Math.max(localRevision, incomingRevision),
    updatedAt: latestIso(local.updatedAt, incoming.updatedAt),
    updatedBy: primary.updatedBy || secondary.updatedBy || '',
  };
}
