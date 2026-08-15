const INBOX_GROUP = {
  id: 'inbox',
  name: '待整理',
  kind: 'inbox',
};

function sanitizeGroupName(name) {
  const trimmed = String(name || '').trim();
  return trimmed || '新分组';
}

function createGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAutoGroupId(category) {
  return `auto:${String(category || '未分类').trim() || '未分类'}`;
}

export function ensureDeskState(rawState, notes) {
  const safeNotes = Array.isArray(notes) ? notes : [];
  const noteIds = new Set(safeNotes.map((note) => note.id).filter(Boolean));
  const categories = Array.from(
    new Set(
      safeNotes
        .map((note) => String(note?.category || '').trim())
        .filter((category) => category && category !== '待分类')
    )
  );
  const rawGroups = Array.isArray(rawState?.groups) ? rawState.groups : [];
  const normalizedGroups = rawGroups
    .filter((group) => group && typeof group.id === 'string' && group.id.trim() && group.id !== 'inbox')
    .map((group) => ({
      id: group.id.trim(),
      name: sanitizeGroupName(group.name),
      kind: group.kind === 'custom' ? 'custom' : 'auto',
      sourceCategory: typeof group.sourceCategory === 'string' ? group.sourceCategory.trim() : '',
    }));

  const autoGroups = categories.map((category) => {
    const existing = normalizedGroups.find(
      (group) => group.kind === 'auto' && (group.sourceCategory === category || group.id === createAutoGroupId(category))
    );

    return existing || {
      id: createAutoGroupId(category),
      name: category,
      kind: 'auto',
      sourceCategory: category,
    };
  });

  const customGroups = normalizedGroups.filter((group) => group.kind === 'custom');
  const groups = [INBOX_GROUP, ...autoGroups, ...customGroups];
  const validGroupIds = new Set(groups.map((group) => group.id));
  const rawMap = rawState?.noteGroupMap && typeof rawState.noteGroupMap === 'object' ? rawState.noteGroupMap : {};
  const noteGroupMap = {};

  for (const note of safeNotes) {
    const category = String(note?.category || '').trim();
    const autoGroup = groups.find((group) => group.kind === 'auto' && group.sourceCategory === category);
    // 笔记已有确定分类（非空且非「待分类」）→ 进对应 auto 分组；
    // 分类未确定或为「待分类」→ 进「待整理」inbox，等待后续补充分类后自动归位。
    const isCategorized = Boolean(category) && category !== '待分类';

    // 自定义分组（group-xxx）的映射只存 localStorage（note.category 不反映它），必须尊重；
    // 而 inbox / auto: 的映射以 note.category 为持久真源——历史遗留的陈旧 inbox/auto 记录
    // 让位于 category，这样「重新归档」更新 category 后笔记能自动归位，不再积压在待整理。
    const mappedGroupId = typeof rawMap[note.id] === 'string' ? rawMap[note.id] : '';
    if (mappedGroupId.startsWith('group-') && validGroupIds.has(mappedGroupId)) {
      noteGroupMap[note.id] = mappedGroupId;
      continue;
    }

    noteGroupMap[note.id] = isCategorized && autoGroup ? autoGroup.id : 'inbox';
  }

  for (const noteId of Object.keys(noteGroupMap)) {
    if (!noteIds.has(noteId)) {
      delete noteGroupMap[noteId];
    }
  }

  const assignedGroupIds = new Set(Object.values(noteGroupMap));
  const populatedGroups = groups.filter(
    (group) => group.kind !== 'auto' || assignedGroupIds.has(group.id)
  );

  return {
    groups: populatedGroups,
    noteGroupMap,
    knownNoteIds: Array.from(noteIds),
  };
}

export function createDeskGroup(state, name) {
  const groups = Array.isArray(state?.groups) ? state.groups.filter((group) => group.id !== 'inbox') : [];

  return {
    ...state,
    groups: [
      INBOX_GROUP,
      ...groups,
      {
        id: createGroupId(),
        name: sanitizeGroupName(name),
        kind: 'custom',
        sourceCategory: '',
      },
    ],
  };
}

export function renameDeskGroup(state, groupId, name) {
  if (groupId === 'inbox') {
    return state;
  }

  return {
    ...state,
    groups: (state.groups || []).map((group) =>
      group.id === groupId
        ? { ...group, name: sanitizeGroupName(name) }
        : group
    ),
  };
}

export function moveNoteToGroup(state, noteId, groupId) {
  const validGroupIds = new Set((state.groups || []).map((group) => group.id));
  const nextGroupId = validGroupIds.has(groupId) ? groupId : 'inbox';

  return {
    ...state,
    noteGroupMap: {
      ...(state.noteGroupMap || {}),
      [noteId]: nextGroupId,
    },
  };
}

export function getNotesInGroup(notes, noteGroupMap, groupId) {
  return (Array.isArray(notes) ? notes : []).filter((note) => (noteGroupMap?.[note.id] || 'inbox') === groupId);
}

export function deleteDeskGroup(state, groupId) {
  if (groupId === 'inbox' || String(groupId).startsWith('auto:')) {
    return state;
  }

  const groups = (state.groups || []).filter((group) => group.id !== groupId);
  const noteGroupMap = { ...(state.noteGroupMap || {}) };

  for (const noteId of Object.keys(noteGroupMap)) {
    if (noteGroupMap[noteId] === groupId) {
      noteGroupMap[noteId] = 'inbox';
    }
  }

  return { ...state, groups, noteGroupMap };
}

export function reorderGroup(state, groupId, newIndex) {
  const groups = Array.isArray(state?.groups) ? [...state.groups] : [];
  const inbox = groups.find(g => g.id === 'inbox');
  const nonInbox = groups.filter(g => g.id !== 'inbox');

  const currentIndex = nonInbox.findIndex(g => g.id === groupId);
  if (currentIndex === -1 || newIndex < 0 || newIndex >= nonInbox.length) return state;

  const [moved] = nonInbox.splice(currentIndex, 1);
  nonInbox.splice(newIndex, 0, moved);

  return {
    ...state,
    groups: inbox ? [inbox, ...nonInbox] : nonInbox,
  };
}
