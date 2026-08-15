import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeskGroup,
  ensureDeskState,
  moveNoteToGroup,
  renameDeskGroup,
} from '../../app/lib/desk-workspace.mjs';

const notes = [
  { id: 'n1', title: '第一条', category: '阅读思考' },
  { id: 'n2', title: '第二条', category: 'AI工具' },
  { id: 'n3', title: '第三条', category: '阅读思考' },
];

test('ensureDeskState places inbox first and keeps existing assignments', () => {
  const state = ensureDeskState(
    {
      groups: [{ id: 'auto:阅读思考', name: '阅读', kind: 'auto', sourceCategory: '阅读思考' }],
      noteGroupMap: {
        n1: 'auto:阅读思考',
        ghost: 'auto:阅读思考',
      },
    },
    notes
  );

  assert.equal(state.groups[0].id, 'inbox');
  assert.equal(state.groups[1].id, 'auto:阅读思考');
  assert.equal(state.groups[2].id, 'auto:AI工具');
  assert.equal(state.noteGroupMap.n1, 'auto:阅读思考');
  assert.equal(state.noteGroupMap.n2, 'auto:AI工具');
  assert.equal(state.noteGroupMap.n3, 'auto:阅读思考');
  assert.equal(state.noteGroupMap.ghost, undefined);
});

test('ensureDeskState routes newly synced notes to their category group (not inbox)', () => {
  const base = ensureDeskState({}, notes);
  const nextNotes = [...notes, { id: 'n4', title: '第四条', category: 'AI工具' }];
  const next = ensureDeskState(base, nextNotes);

  assert.equal(next.noteGroupMap.n1, 'auto:阅读思考');
  assert.equal(next.noteGroupMap.n2, 'auto:AI工具');
  assert.equal(next.noteGroupMap.n4, 'auto:AI工具');
});

test('ensureDeskState creates an auto group for a newly categorized note', () => {
  const base = ensureDeskState({}, notes);
  const next = ensureDeskState(base, [
    ...notes,
    { id: 'n4', title: '第四条', category: '方法论' },
  ]);

  assert.equal(next.noteGroupMap.n4, 'auto:方法论');
  assert.equal(next.groups.some((group) => group.id === 'auto:方法论'), true);
});

test('ensureDeskState sends uncategorized notes (待分类) to inbox without an auto group', () => {
  const base = ensureDeskState({}, notes);
  const next = ensureDeskState(base, [
    ...notes,
    { id: 'n5', title: '第五条', category: '待分类' },
  ]);

  assert.equal(next.noteGroupMap.n5, 'inbox');
  assert.equal(next.groups.some((group) => group.id === 'auto:待分类'), false);
});

test('ensureDeskState preserves renamed auto group names', () => {
  const base = ensureDeskState({}, notes);
  const renamed = renameDeskGroup(base, 'auto:阅读思考', '阅读方法');
  const next = ensureDeskState(renamed, notes);

  assert.equal(next.groups.find((group) => group.id === 'auto:阅读思考').name, '阅读方法');
});

test('createDeskGroup appends a new editable group without disturbing existing notes', () => {
  const base = ensureDeskState({}, notes);
  const next = createDeskGroup(base, '新分组');

  assert.equal(next.groups[0].id, 'inbox');
  assert.equal(next.groups.some((group) => group.name === '新分组'), true);
  assert.equal(next.noteGroupMap.n1, 'auto:阅读思考');
});

test('renameDeskGroup trims names and ignores inbox', () => {
  const base = createDeskGroup(ensureDeskState({}, notes), '待改名');
  const customGroup = base.groups.find((group) => group.name === '待改名');
  const renamed = renameDeskGroup(base, customGroup.id, '  阅读思考  ');
  const inboxRename = renameDeskGroup(renamed, 'inbox', '别改我');

  assert.equal(renamed.groups.find((group) => group.id === customGroup.id).name, '阅读思考');
  assert.equal(inboxRename.groups[0].name, '待整理');
});

test('moveNoteToGroup falls back to inbox when target group is missing', () => {
  const base = createDeskGroup(ensureDeskState({}, notes), '方法论');
  const groupId = base.groups.find((group) => group.name === '方法论').id;
  const moved = moveNoteToGroup(base, 'n2', groupId);
  const fallback = moveNoteToGroup(moved, 'n2', 'missing-group');

  assert.equal(moved.noteGroupMap.n2, groupId);
  assert.equal(fallback.noteGroupMap.n2, 'inbox');
});

test('ensureDeskState: stale inbox mapping yields to a determined category', () => {
  // 历史遗留：localStorage 里记着 inbox，但 note.category 其实已被正确推断 → 应归位到 auto 组，
  // 而不是继续积压在待整理（这是「重新归档」能生效的前提）。
  const state = ensureDeskState(
    {
      groups: [{ id: 'inbox', name: '待整理', kind: 'inbox' }],
      noteGroupMap: { n1: 'inbox' },
    },
    [{ id: 'n1', title: '一条编程笔记', category: '编程开发' }]
  );

  assert.equal(state.noteGroupMap.n1, 'auto:编程开发');
  assert.equal(state.groups.some((group) => group.id === 'auto:编程开发'), true);
});

test('ensureDeskState: custom group-xxx mapping is still respected over category', () => {
  // 用户手动拖到自定义分组 group-xxx 只存 localStorage，category 不反映它 → 必须尊重映射。
  const state = ensureDeskState(
    {
      groups: [
        { id: 'inbox', name: '待整理', kind: 'inbox' },
        { id: 'group-custom1', name: '我的收藏夹', kind: 'custom', sourceCategory: '' },
      ],
      noteGroupMap: { n1: 'group-custom1' },
    },
    [{ id: 'n1', title: '一条笔记', category: '编程开发' }]
  );

  assert.equal(state.noteGroupMap.n1, 'group-custom1');
});

test('ensureDeskState routes fallback 其他 notes to their auto group (not inbox)', () => {
  const next = ensureDeskState({}, [
    ...notes,
    { id: 'n6', title: '第六条', category: '其他' },
  ]);

  assert.equal(next.noteGroupMap.n6, 'auto:其他');
  assert.equal(next.groups.some((group) => group.id === 'auto:其他'), true);
});
