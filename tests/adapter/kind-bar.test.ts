/**
 * 🔴 **種類の札を、効かない面に出さない**(#478)。
 *
 * ## user から見て何が起きていたか
 *
 * 札は**一覧以外のタブでも出たまま**で、そこで押すと
 * **押された印も付かず「解除」も出ない**のに、**絞りは入って**いた ──
 * 一覧へ戻ると**ノートが減っている**。⚠ しかもその面からは**解除できない**。
 *
 * 🔑 原因は 1 つ:札を描く renderer が**一覧の面の中**に在ったのに、
 *   **帯は面をまたいで居座る**(左の列に在る)ため、
 *   **他のタブでは 1 度も描き直されなかった**。
 *
 * ## この検査が守るもの ── **両方向**
 *
 * ⚠ 片方向だけだと、次に面を足した人が静かに穴を開ける:
 * - **効かないのに出す** → 押しても何も起きない(dead click)。⚠ そのうえ
 *   **絞りだけ入る**ので、あとで一覧へ行くとノートが消えている
 * - **効くのに出さない** → 動く絞り込みを 1 つ失う(記法を減らすのと同じ向き)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BROWSE_MODES,
  KIND_FILTER_MODES,
  kindFilterApplies,
  type BrowseMode,
} from '../../src/adapter/ui/render/browse-mode';

/**
 * 探し方 → その面を描く file。
 * ⚠ **`list` は 2 本**(行は `sidebar`、並びの規則は `filer` が持つ)。
 */
const PANE_FILES: Readonly<Record<BrowseMode, readonly string[]>> = {
  list: ['sidebar.ts', 'filer.ts'],
  filer: ['filer.ts'],
  launcher: ['launcher.ts'],
  schedule: ['schedule.ts'],
  contacts: ['contacts.ts'],
};

const readsKindFilter = (mode: BrowseMode): boolean =>
  PANE_FILES[mode].some((f) =>
    readFileSync(`src/adapter/ui/render/${f}`, 'utf-8').includes('kindFilter'),
  );

describe('種類の札を出す面', () => {
  it('⚠ 表が探し方を全部覆っている(足した面が黙って漏れない)', () => {
    for (const m of BROWSE_MODES) {
      expect(PANE_FILES[m], `${m} の面の file が表に無い`).toBeDefined();
      expect(PANE_FILES[m].length, `${m} の面の file が空`).toBeGreaterThan(0);
    }
    expect(Object.keys(PANE_FILES)).toHaveLength(BROWSE_MODES.length);
  });

  it('🔴 「出す」と決めた面は、本当に絞りを読んでいる(効くのに出さない/効かないのに出す、が無い)', () => {
    const wrong: string[] = [];
    for (const m of BROWSE_MODES) {
      const shows = kindFilterApplies(m);
      const reads = readsKindFilter(m);
      if (shows && !reads) wrong.push(`${m}: 札を出すのに、面が kindFilter を読んでいない`);
      if (!shows && reads) wrong.push(`${m}: 面は kindFilter を読むのに、札を出さない`);
    }
    expect(wrong, wrong.join(' / ')).toEqual([]);
  });

  it('⚠ 空振り防止 ── 両側が実際に在る(全部 true / 全部 false になっていない)', () => {
    const on = BROWSE_MODES.filter((m) => kindFilterApplies(m));
    const off = BROWSE_MODES.filter((m) => !kindFilterApplies(m));
    // 🔑 どちらかが 0 件なら、上の突合は**片側しか通っていない**
    expect(on.length, '札を出す面が 1 つも無い').toBeGreaterThan(0);
    expect(off.length, '札を出さない面が 1 つも無い').toBeGreaterThan(0);
    // ⚠ 読み取りの側も両方が出ること(grep が壊れたら全部同じ答えになる)
    expect(BROWSE_MODES.filter(readsKindFilter).length, '読む面が 0 件(grep が壊れている)').toBeGreaterThan(0);
    expect(
      BROWSE_MODES.filter((m) => !readsKindFilter(m)).length,
      '読まない面が 0 件(grep が壊れている)',
    ).toBeGreaterThan(0);
  });

  it('🔑 いまの答え(変えるときは理由ごと変える)', () => {
    expect([...KIND_FILTER_MODES].sort()).toEqual(['filer', 'list', 'schedule']);
  });
});
