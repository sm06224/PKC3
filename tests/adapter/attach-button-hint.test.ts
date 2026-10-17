/** @vitest-environment happy-dom */
/**
 * 🔴 **「添付」ボタンの説明は、別の「取り込む」ボタンと同じ言葉を使わない**(#1163 依頼 102-3。推薦 A)。
 *
 * 直す前は「ファイルを取り込んで、開いているノートの本文に入れます」で、同じ並びの「取り込む」ボタン
 * (バックアップなどを読み込む)と、同じ「取り込む」が別の動作を指していた。
 * ⚠ 説明は 2 か所に在る(帯のボタンの `title` と、右クリック・スマホの `⋯` の説明表)── 片方だけ直すと
 * 同じ操作に 2 通りの説明ができる(CLAUDE.md §7)。
 */
import { describe, expect, it } from 'vitest';
import { ENTRY_ACTION_HINTS } from '../../src/features/entry-actions';
import { buildShell } from '../../src/adapter/ui/render/shell';

describe('「添付」ボタンの説明(#1163 依頼 102-3)', () => {
  const WANT = 'ファイルを選んで、添付として開いているノートの本文に入れます';

  it('🔴 説明表の字が「選んで」で、「取り込」を含まない', () => {
    expect(ENTRY_ACTION_HINTS['attach-file']).toBe(WANT);
    expect(ENTRY_ACTION_HINTS['attach-file']).not.toContain('取り込');
  });

  it('🔴 帯の「添付」ボタンの title が、説明表と同じ字になっている(2 か所を揃える)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const buttons = [...root.querySelectorAll<HTMLElement>('[data-pkc-action="attach-file"]')];
    // 空振り防止: ボタンが 1 つも無ければ、下の全数は何も見ていない
    expect(buttons.length, '添付のボタンが画面に無い').toBeGreaterThan(0);
    const titled = buttons.filter((b) => b.title !== '');
    expect(titled.length, 'title を持つ添付のボタンが無い').toBeGreaterThan(0);
    for (const b of titled) expect(b.title).toBe(ENTRY_ACTION_HINTS['attach-file']);
  });
});
