(() => {
  const SOURCE = 'kankan-note-page-data';
  const REQUEST_EVENT = 'kankan-note-capture-request';

  function noteIdFromLocation() {
    return location.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/i)?.[1] || '';
  }

  function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function firstString(object, keys) {
    for (const key of keys) {
      const value = cleanString(object?.[key]);
      if (value) return value;
    }
    return '';
  }

  function imageUrlFromItem(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';

    const direct = firstString(item, ['urlDefault', 'urlPre', 'url']);
    if (/^https?:\/\//i.test(direct)) return direct.replace(/^http:/i, 'https:');

    for (const listKey of ['urlList', 'infoList', 'stream']) {
      const list = item[listKey];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const nested = imageUrlFromItem(entry);
        if (nested) return nested;
      }
    }
    return '';
  }

  function imageUrlsFromNote(note) {
    const urls = [];
    for (const key of ['imageList', 'images', 'image_list']) {
      const list = note?.[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const url = imageUrlFromItem(item);
        if (url) urls.push(url);
      }
    }
    return Array.from(new Set(urls)).slice(0, 20);
  }

  function isVideoUrl(value) {
    try {
      const url = new URL(value.replace(/^http:/i, 'https:'));
      return url.protocol === 'https:'
        && (url.hostname.endsWith('.xhscdn.com') || url.hostname.endsWith('.xhsimg.com'))
        && !/\.(?:avif|gif|heic|heif|jpe?g|png|webp)(?:$|\?)/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function videoUrlFromNote(note) {
    if (!note || typeof note !== 'object') return '';
    const queue = [{ value: note, path: '' }];
    const visited = new WeakSet();
    const candidates = [];
    while (queue.length && candidates.length < 30) {
      const { value, path } = queue.shift();
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      for (const [key, entry] of Object.entries(value)) {
        const entryPath = `${path}.${key}`;
        if (typeof entry === 'string' && isVideoUrl(entry)) {
          const url = new URL(entry.replace(/^http:/i, 'https:'));
          const score = (/video/i.test(url.hostname) ? 5 : 0)
            + (/video|stream|h264|h265|avc|hevc|master|originVideo/i.test(entryPath) ? 4 : 0)
            + (/masterUrl|master_url|backupUrls|url/i.test(key) ? 2 : 0)
            - (/cover|image|avatar/i.test(entryPath) ? 6 : 0);
          if (score >= 4) candidates.push({ url: url.toString(), score });
        } else if (entry && typeof entry === 'object') {
          queue.push({ value: entry, path: entryPath });
        }
      }
    }
    return candidates.sort((a, b) => b.score - a.score)[0]?.url || '';
  }

  function looksLikeCurrentNote(value, noteId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidateId = firstString(value, ['noteId', 'note_id', 'id']);
    if (candidateId !== noteId) return false;
    return Boolean(
      firstString(value, ['title', 'displayTitle', 'desc', 'description'])
      || imageUrlsFromNote(value).length,
    );
  }

  function findCurrentNote(root, noteId) {
    if (!root || typeof root !== 'object') return null;

    const directCandidates = [
      root?.note?.noteDetailMap?.[noteId]?.note,
      root?.note?.noteDetailMap?.[noteId],
      root?.noteData?.data?.noteData,
      root?.noteData?.note,
    ];
    const direct = directCandidates.find((value) => looksLikeCurrentNote(value, noteId));
    if (direct) return direct;

    const queue = [{ value: root, depth: 0 }];
    const visited = new WeakSet();
    let inspected = 0;
    while (queue.length && inspected < 30000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      visited.add(value);
      inspected += 1;
      if (looksLikeCurrentNote(value, noteId)) return value;
      if (depth >= 10) continue;

      let entries;
      try {
        entries = Array.isArray(value) ? value : Object.values(value);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry && typeof entry === 'object') queue.push({ value: entry, depth: depth + 1 });
      }
    }
    return null;
  }

  function capturePageData() {
    const noteId = noteIdFromLocation();
    if (!noteId) return null;

    const roots = [
      window.__INITIAL_STATE__?.note,
      window.__INITIAL_SSR_STATE__?.note,
      window.__NUXT__?.note,
      window.__INITIAL_STATE__?.noteData,
      window.__INITIAL_SSR_STATE__?.noteData,
    ];
    const note = roots.map((root) => findCurrentNote(root, noteId)).find(Boolean);
    if (!note) return { id: noteId, imageUrls: [] };

    const user = note.user || note.author || {};
    return {
      id: noteId,
      title: firstString(note, ['title', 'displayTitle']),
      content: firstString(note, ['desc', 'description', 'content']),
      imageUrls: imageUrlsFromNote(note),
      videoUrl: videoUrlFromNote(note),
      type: note.type === 'video' || note.video ? 'video' : 'normal',
      author: {
        name: firstString(user, ['nickname', 'name', 'nickName']),
        avatar: firstString(user, ['avatar', 'image']),
        userId: firstString(user, ['userId', 'user_id', 'id']),
      },
    };
  }

  function publish() {
    window.postMessage({ source: SOURCE, payload: capturePageData() }, location.origin);
  }

  document.addEventListener(REQUEST_EVENT, publish);
  publish();
})();
