/**
 * #1385: 片づけ 3 本(縮める / 索引 / 添付)が、同じ口 `reportMaintenance` で処理の記録へ報告する。
 * 見るのは**実走した結果の記録**(出所と固定の頭)── 共通 file の関数を直に叩くだけでなく、各係を走らせて確かめる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  maintenanceIdentity,
  reportMaintenance,
  type MaintenanceJobPost,
} from '../../src/adapter/platform/storage/maintenance-task';
import { StorageVacuum } from '../../src/adapter/platform/storage/vacuum-run';
import { AutoOptimizer } from '../../src/adapter/platform/storage/auto-optimize';
import { ASSET_GC_TASK } from '../../src/adapter/platform/storage/asset-gc';
import type { VacuumResult } from '../../src/adapter/platform/storage/protocol';
import { MESSAGE_SOURCE_LABEL } from '../../src/features/message/message-log';

const MiB = 1024 * 1024;
const gaugeOf = (fileMiB: number, freeMiB: number): VacuumResult['before'] => ({
  pageCount: (fileMiB * MiB) / 4096,
  pageSize: 4096,
  freelistCount: (freeMiB * MiB) / 4096,
  fileBytes: fileMiB * MiB,
  freeBytes: freeMiB * MiB,
  ftsSegments: 1,
  journalMode: 'truncate',
  tempStore: 0,
  synchronous: 2,
  elapsedMs: 1,
});

describe('reportMaintenance', () => {
  const task = maintenanceIdentity('storage-vacuum');

  it('done は固定の頭なし、failed は text と同じ fixedHead、refused は積まない', () => {
    const got: MaintenanceJobPost[] = [];
    const post = (m: MaintenanceJobPost): void => void got.push(m);
    reportMaintenance(post, task, { kind: 'done', text: '終わり' });
    reportMaintenance(post, task, { kind: 'failed', text: '失敗した' });
    reportMaintenance(post, task, { kind: 'refused', text: '断った' });
    expect(got).toEqual([
      { kind: 'job', source: 'storage-vacuum', text: '終わり' },
      { kind: 'job', source: 'storage-vacuum', text: '失敗した', fixedHead: '失敗した' },
    ]);
  });

  it('呼び名は処理の記録の見出しと同じ表から引く(画面の呼び名を 2 か所に書かない)', () => {
    for (const t of [new StorageVacuum(), ASSET_GC_TASK]) {
      expect(t.name, `${t.source} の呼び名が表に無い`).toBe(MESSAGE_SOURCE_LABEL[t.source]);
      expect(t.name.length).toBeGreaterThan(0);
    }
    expect(maintenanceIdentity('storage-optimize').name).toBe('索引の整理');
  });
});

/** 索引の自動の実走(出所 storage-optimize・失敗は固定の頭つき)は tests/adapter/auto-optimize.test.ts「処理の記録」が見る。 */
describe('実走して記録の出所と固定の頭を見る', () => {
  it('縮める: 成功は done(頭なし)・失敗は failed(頭つき)、出所は storage-vacuum', async () => {
    const posts: MaintenanceJobPost[] = [];
    let fail = false;
    const v = new StorageVacuum();
    v.attach({
      holdsWriterLease: () => true,
      run: (job) => job(),
      gauge: async () => gaugeOf(100, 20),
      quota: async () => ({ usage: 10 * MiB, quota: 10_000 * MiB }),
      vacuum: async () => {
        if (fail) throw new Error('秘密');
        return { elapsedMs: 2100, before: gaugeOf(100, 20), after: gaugeOf(80, 0) } as VacuumResult;
      },
      post: (m) => void posts.push(m),
    });
    expect((await v.run()).kind).toBe('done');
    fail = true;
    expect((await v.run()).kind).toBe('failed');
    expect(posts.map((p) => p.source)).toEqual(['storage-vacuum', 'storage-vacuum']);
    expect(posts[0]?.fixedHead).toBeUndefined();
    expect(posts[1]?.fixedHead).toBe(posts[1]?.text);
    expect(posts[1]?.text, '例外の字をそのまま出していない').not.toContain('秘密');
    expect(v.source).toBe('storage-vacuum');
  });

  it('索引の自動も同じ名乗りを持つ(出所が表の見出しと一致)', () => {
    const a = new AutoOptimizer({
      holdsWriterLease: () => false,
      run: (job) => job(),
      optimize: () => Promise.reject(new Error('unused')),
      post: () => undefined,
    });
    expect(a.source).toBe('storage-optimize');
    expect(a.name).toBe(MESSAGE_SOURCE_LABEL['storage-optimize']);
    a.dispose();
  });
});

describe('構造', () => {
  it('共通 file は縮める係・自動の係のどちらも import しない', () => {
    const src = readFileSync('src/adapter/platform/storage/maintenance-task.ts', 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/from\s+'\.\/(vacuum-run|auto-optimize)'/);
  });

  it('3 本とも `reportMaintenance` を通し、`post({ kind: \'job\'` を直に呼ばない', () => {
    for (const f of ['vacuum-run', 'auto-optimize', 'asset-gc']) {
      const code = readFileSync(`src/adapter/platform/storage/${f}.ts`, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${f} が reportMaintenance を通していない`).toContain('reportMaintenance(');
      expect(code, `${f} が処理の記録へ直に積んでいる`).not.toMatch(/post\(\{\s*kind:\s*'job'/);
    }
  });
});
