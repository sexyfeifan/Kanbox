export function autoBackupSlot(now = new Date(), intervalHours = 6) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('自动备份时间无效');
  const hours = Math.max(1, Math.min(24, Number(intervalHours) || 6));
  const slot = new Date(date);
  slot.setUTCMinutes(0, 0, 0);
  slot.setUTCHours(Math.floor(slot.getUTCHours() / hours) * hours);
  return slot.toISOString().slice(0, 13).replace('T', '-');
}

export function buildMetadataBackup({ version, type = 'auto', now = new Date(), deviceId = '', notes, workspace, dailyReview, syncMeta }) {
  return {
    version: String(version || ''),
    type,
    exportedAt: now.toISOString(),
    sourceDeviceId: String(deviceId || ''),
    notes: Array.isArray(notes) ? notes : [],
    workspace: workspace && typeof workspace === 'object' ? workspace : {},
    dailyReview: dailyReview && typeof dailyReview === 'object' ? dailyReview : {},
    syncMeta: syncMeta && typeof syncMeta === 'object' ? syncMeta : { tombstones: {} },
  };
}

export function autoBackupsToRemove(files, keep = 14) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => /^auto-backup-\d{4}-\d{2}-\d{2}(?:-\d{2})?\.json$/.test(file))
    .sort()
    .reverse()
    .slice(Math.max(1, Number(keep) || 14));
}
