import assert from 'node:assert/strict';
import test from 'node:test';
import { autoBackupSlot, autoBackupsToRemove, buildMetadataBackup } from './metadata-backup.mjs';

test('自动备份按六小时分槽，同一槽位稳定', () => {
  assert.equal(autoBackupSlot(new Date('2026-09-01T07:59:00Z')), '2026-09-01-06');
  assert.equal(autoBackupSlot(new Date('2026-09-01T11:59:00Z')), '2026-09-01-06');
  assert.equal(autoBackupSlot(new Date('2026-09-01T12:00:00Z')), '2026-09-01-12');
});

test('自动快照包含回顾进度和删除墓碑', () => {
  const payload = buildMetadataBackup({
    version: '0.8.12', now: new Date('2026-09-01T00:00:00Z'), deviceId: 'device-a',
    notes: [{ id: 'a' }], workspace: { groups: [] }, dailyReview: { days: { today: {} } },
    syncMeta: { tombstones: { deleted: { revision: 2 } } },
  });
  assert.equal(payload.notes.length, 1);
  assert.deepEqual(payload.dailyReview, { days: { today: {} } });
  assert.equal(payload.syncMeta.tombstones.deleted.revision, 2);
});

test('自动备份只清理超出保留数的已知快照', () => {
  const files = Array.from({ length: 16 }, (_, index) => `auto-backup-2026-09-${String(index + 1).padStart(2, '0')}-00.json`);
  assert.deepEqual(autoBackupsToRemove([...files, 'backup-manual.json'], 14), [files[1], files[0]]);
});
