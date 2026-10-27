/** #1385: 片づけ 3 本に共通の約束(記録へ積む形)と、互いを import しない構造の pin。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  postMaintenanceDone,
  postMaintenanceFailed,
  type MaintenanceJobPost,
} from '../../src/adapter/platform/storage/maintenance-task';
import { StorageVacuum } from '../../src/adapter/platform/storage/vacuum-run';
import { AutoOptimizer } from '../../src/adapter/platform/storage/auto-optimize';

describe('maintenance-task', () => {
  it('done は fixedHead なし、failed は text と同じ fixedHead を付ける', () => {
    const got: MaintenanceJobPost[] = [];
    postMaintenanceDone((m) => got.push(m), 'src-a', '終わり');
    postMaintenanceFailed((m) => got.push(m), 'src-a', '失敗した');
    expect(got).toEqual([
      { kind: 'job', source: 'src-a', text: '終わり' },
      { kind: 'job', source: 'src-a', text: '失敗した', fixedHead: '失敗した' },
    ]);
  });

  it('縮める係と自動の係は、それぞれ別の出所を名乗る', () => {
    const v = new StorageVacuum();
    const a = new AutoOptimizer({
      holdsWriterLease: () => false,
      run: (job) => job(),
      optimize: () => Promise.reject(new Error('unused')),
      post: () => undefined,
    });
    expect(v.name.length).toBeGreaterThan(0);
    expect(a.name.length).toBeGreaterThan(0);
    expect(v.source).not.toBe(a.source);
    a.dispose();
  });

  it('共通 file は縮める係・自動の係のどちらも import しない', () => {
    const src = readFileSync('src/adapter/platform/storage/maintenance-task.ts', 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/from\s+'\.\/(vacuum-run|auto-optimize)'/);
  });
});
