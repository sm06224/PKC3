/** @vitest-environment happy-dom */
/**
 * 🔴 **確認が「出ていない」ことを検出する**(2026-08-06。user 報告 minor
 * 「確認ダイアログが抑止されるとボタンが恒久的に無反応」)。
 *
 * Chromium で user が「このページにこれ以上ダイアログを表示させない」を選ぶと、
 * 以後の `confirm` は**何も表示せずに即 false**。確認つきの操作は全部
 * 「取り消し」になるので、**押しても 1 ドットも変わらないボタン**になる。
 *
 * ⚠ 抑止は解除できない(仕様)。ここが守るのは「**黙らせない**」の 1 点だけ。
 */
import { describe, expect, it } from 'vitest';
import {
  askConfirm,
  SUPPRESSED_MESSAGE,
  SUPPRESSED_MS,
} from '../../src/adapter/platform/ask-confirm';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

/** 手で進める時計(実時間を待たない)。 */
function clock(startAt = 1000) {
  let t = startAt;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('askConfirm', () => {
  it('受けたら ok(抑止の疑いは立てない)', () => {
    const r = askConfirm('よい?', { ask: () => true, now: () => 0, whenAbsent: false });
    expect(r).toEqual({ ok: true, suppressed: false });
  });

  it('🔴 即 false は「表示されていない」疑い', () => {
    const c = clock();
    const r = askConfirm('よい?', { ask: () => false, now: c.now, whenAbsent: false });
    expect(r, '抑止を見逃した(ボタンが無反応に見える)').toEqual({
      ok: false,
      suppressed: true,
    });
  });

  it('🔴 人が取り消したときは疑わない(誤った案内を出さない)', () => {
    const c = clock();
    const r = askConfirm('よい?', {
      ask: () => {
        c.advance(SUPPRESSED_MS + 200); // 人が読んで押すまでの時間
        return false;
      },
      now: c.now,
      whenAbsent: false,
    });
    expect(r).toEqual({ ok: false, suppressed: false });
  });

  /**
   * ⚠ **confirm が無い環境の倒し方は呼び側が決める**。一括・不可逆は通さない
   * (`false`)、単発の削除は自動化として通す(`true`)── ここで一律にすると
   * 片方が必ず間違う。
   */
  it('confirm が無い環境は呼び側の既定に従う(抑止ではない)', () => {
    for (const whenAbsent of [true, false]) {
      const r = askConfirm('よい?', { ask: () => undefined, now: () => 0, whenAbsent });
      expect(r).toEqual({ ok: whenAbsent, suppressed: false });
    }
  });
});

describe('抑止されたときに理由が出る(画面の配線)', () => {
  function rig() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'a',
          title: 't-a',
          archetype: 'text',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    return { root, d };
  }

  /**
   * ⚠ happy-dom は **`window.confirm` を持たない**ので、`vi.spyOn` は使えない
   * (「関数ではない」で落ちる)。ここは**無いものを 1 つ足して、後で外す**
   * ── グローバルを丸ごと差し替えるのではないので、CLAUDE.md の
   * 「必要なものだけ・コンストラクタを壊さない」と同じ向きである。
   */
  function withConfirm(impl: () => boolean, run: () => void): void {
    Object.defineProperty(window, 'confirm', { configurable: true, value: impl });
    try {
      run();
    } finally {
      delete (window as { confirm?: unknown }).confirm;
    }
  }

  function deleteButton(root: HTMLElement): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'delete-entry');
    btn.setAttribute('data-pkc-entry', 'a');
    root.append(btn);
    return btn;
  }

  it('🔴 削除が抑止されたら、理由が state に出る(黙って無反応にしない)', () => {
    const { root, d } = rig();
    withConfirm(
      () => false, // 抑止された confirm は同期に false
      () => deleteButton(root).click(),
    );
    expect(d.getState().error, '抑止されたのに理由が出ていない').toBe(SUPPRESSED_MESSAGE);
    // ⚠ 操作は**進めない**(抑止を迂回しない)
    expect(d.getState().entryMetas.has('a'), '確認を飛ばして削除した').toBe(true);
  });

  it('人が取り消したときは理由を出さない(邪魔をしない)', () => {
    const { root, d } = rig();
    withConfirm(
      () => {
        // 人が読んで押すまでの時間を進める。⚠ 実時間で進める ──
        // fake timer は `performance.now()` を動かさない
        const until = performance.now() + SUPPRESSED_MS + 2;
        while (performance.now() < until) {
          /* busy wait */
        }
        return false;
      },
      () => deleteButton(root).click(),
    );
    expect(d.getState().error, '取り消しただけで案内が出た').toBeNull();
  });

  it('🔴 受けたら今までどおり進む(案内の追加で操作を壊していない)', () => {
    const { root, d } = rig();
    withConfirm(
      () => true,
      () => deleteButton(root).click(),
    );
    expect(d.getState().error).toBeNull();
    expect(d.getState().entryMetas.has('a'), '受けたのに削除されない').toBe(false);
  });
});
