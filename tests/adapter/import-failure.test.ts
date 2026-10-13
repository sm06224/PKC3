/** @vitest-environment happy-dom */
/**
 * 🔴 **取り込みの失敗は「取り込み時の注意」の面に出す**(依頼 70-C1)。
 *
 * 直す前は `OP_FAILED` で画面下の灰色の 1 行にだけ出て、別のノートを選ぶと消えた。
 * 守るもの:①入口 7 つのうち代表(混在 / 複数のバックアップ / md の門)が面の口へ出る
 * ②そのとき `OP_FAILED` を出さない ③面の口が無い配線では従来どおり ④面は閉じるまで残り、
 * 前の取り込みの「取り消す」を付けない ⑤main.ts の配線
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeOnly } from '../helpers/code-only';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import { importMarkdownFiles } from '../../src/adapter/ui/actions/import-markdown';
import { importFailurePanel } from '../../src/adapter/ui/actions/import-undo';
import { showNotices } from '../../src/adapter/ui/render/notices';
import type { ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return d;
}

function withFailure() {
  const failed: string[] = [];
  const deps = { reportFailure: (m: string) => void failed.push(m) } as unknown as ImportDeps;
  return { failed, deps };
}

describe('取り込みの失敗を注意の面へ (依頼 70-C1)', () => {
  it('🔴 種類の違うファイルの混在は、面の口へ出る(OP_FAILED にしない)', async () => {
    const d = booted();
    const { failed, deps } = withFailure();
    const r = await importFiles(d, deps, [new File(['# a'], 'a.md'), new File(['x'], 'b.vcf')]);
    expect(r).toBeNull();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('分けて取り込んでください');
    expect(d.getState().error, '画面下の 1 行にも出ている(消える方へ出している)').toBeNull();
  });

  it('🔴 バックアップを 2 つ選んだ断りも、面の口へ出る', async () => {
    const d = booted();
    const { failed, deps } = withFailure();
    await importFiles(d, deps, [new File(['{}'], 'a.json'), new File(['{}'], 'b.json')]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('1 つずつ');
    expect(d.getState().error).toBeNull();
  });

  it('🔴 md の経路の門(編集中)も、面の口へ出る', async () => {
    const { failed, deps } = withFailure();
    // ready でない状態として、起動前の dispatcher を使う
    const cold = new Dispatcher();
    await importMarkdownFiles(cold, deps, [new File(['# a'], 'a.md')]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('取り込んでください');
    expect(cold.getState().error).toBeNull();
  });

  it('対照群: 面の口が無い配線では、従来どおり OP_FAILED で出す', async () => {
    const d = booted();
    await importFiles(d, {} as unknown as ImportDeps, [
      new File(['# a'], 'a.md'),
      new File(['x'], 'b.vcf'),
    ]);
    expect(d.getState().error ?? '').toContain('分けて取り込んでください');
  });

  it('🔴 面は題が「取り込み時の注意」で、閉じるまで残り、取り消しの操作を付けない', () => {
    const region = document.createElement('div');
    const p = importFailurePanel('バックアップや PKC2 の書き出しは 1 つずつ取り込んでください');
    expect(p.action, '前の取り込みの取り消しを付けている').toBeNull();
    showNotices(region, p.title, p.notes, p.action);
    expect(region.textContent).toContain('取り込み時の注意');
    expect(region.textContent).toContain('1 つずつ取り込んでください');
    expect(region.querySelector('[data-pkc-action="undo-import"]')).toBeNull();
  });

  it('🔴 main.ts: 失敗の口が面へ繋がっている', () => {
    const main = codeOnly(readFileSync('src/main.ts', 'utf-8'));
    const at = main.indexOf('reportFailure:');
    expect(at, 'reportFailure が配線されていない').toBeGreaterThan(-1);
    const block = main.slice(at, at + 300);
    expect(block).toContain('importFailurePanel(message)');
    expect(block).toContain('showNotices(regions.notices');
  });
});
