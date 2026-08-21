import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeNoteCollections,
  mergeNoteRecords,
  mergeWorkspaceRecords,
  stampRecord,
} from './sync-merge.mjs';

const id = (value) => value.toString(16).padStart(24, '0');

test('newer revision wins while tags and first saved time are preserved', () => {
  const local = { id: id(1), title: 'local', tags: ['本机'], savedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', revision: 2 };
  const incoming = { id: id(1), title: 'remote', tags: ['远端'], savedAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z', revision: 3 };
  const result = mergeNoteRecords(local, incoming);
  assert.equal(result.decision, 'incoming');
  assert.equal(result.note.title, 'remote');
  assert.deepEqual(result.note.tags, ['本机', '远端'].sort());
  assert.equal(result.note.savedAt, local.savedAt);
});

test('same-revision divergent edits are merged deterministically and reported', () => {
  const left = { id: id(2), title: 'A', content: 'left', tags: ['a'], updatedAt: '2026-01-01T00:00:00Z', revision: 4 };
  const right = { id: id(2), title: 'B', content: 'right', tags: ['b'], updatedAt: '2026-01-01T00:00:00Z', revision: 4 };
  const leftRight = mergeNoteRecords(left, right);
  const rightLeft = mergeNoteRecords(right, left);
  assert.equal(leftRight.conflict, true);
  assert.equal(rightLeft.conflict, true);
  assert.deepEqual(leftRight.note, rightLeft.note);
  assert.deepEqual(leftRight.note.tags, ['a', 'b']);
});

test('large note collections merge without quadratic lookup', () => {
  const local = Array.from({ length: 10_000 }, (_, index) => ({ id: id(index + 1), title: `local-${index}`, revision: 1 }));
  const incoming = Array.from({ length: 10_000 }, (_, index) => ({ id: id(index + 1), title: `remote-${index}`, revision: 2 }));
  const startedAt = Date.now();
  const result = mergeNoteCollections(local, incoming);
  assert.equal(result.notes.length, 10_000);
  assert.equal(result.stats.updated, 10_000);
  assert.ok(Date.now() - startedAt < 5_000, '10k merge should complete within five seconds');
});

test('workspace merge keeps groups from both devices and newer mappings', () => {
  const local = { groups: [{ id: 'inbox' }, { id: 'group-local' }], noteGroupMap: { [id(1)]: 'group-local' }, revision: 2 };
  const incoming = { groups: [{ id: 'inbox' }, { id: 'group-remote' }], noteGroupMap: { [id(1)]: 'group-remote' }, revision: 3 };
  const merged = mergeWorkspaceRecords(local, incoming);
  assert.deepEqual(merged.groups.map((group) => group.id), ['inbox', 'group-remote', 'group-local']);
  assert.equal(merged.noteGroupMap[id(1)], 'group-remote');
});

test('stampRecord advances revision and records the editing device', () => {
  const stamped = stampRecord({ revision: 7 }, { now: '2026-08-22T00:00:00Z', deviceId: 'device-a' });
  assert.equal(stamped.revision, 8);
  assert.equal(stamped.updatedBy, 'device-a');
});
