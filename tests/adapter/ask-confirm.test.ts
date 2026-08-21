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
  SUPPRESSED_MS,
} from '../../src/adapter/platform/ask-confirm';
import { answerDialog, dialogMessage } from './dialog-helper';
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

  /**
   * 🔴 **この面はもう native `confirm` を使わない**(#299 段②、2026-08-21)。
   *
   * ⚠ ここに在った 3 件(抑止されたら理由 / 取り消しでは出さない / 受けたら進む)は
   *   **`window.confirm` を差し替えて `delete-entry` を押す**形だった。確認が
   *   アプリ自身のダイアログになったので、その配線は**存在しない** ── 差し替えた
   *   `confirm` は**呼ばれない**ので、残しても「呼ばれないものを検査する」空振りになる。
   * 🔑 だから**主張を裏返して pin する**:この面は **native を 1 度も呼ばない**。
   *   これは「戻ってこないこと」の見張りである。
   * ⚠ `askConfirm` そのものの test(この file の上半分)は**残す** ──
   *   `main.ts` の 4 面がまだ native を使っており、段③ で移す。
   */
  it('🔴 削除は native の confirm を 1 度も呼ばない(アプリ自身のダイアログ)', async () => {
    const { root, d } = rig();
    let nativeCalls = 0;
    withConfirm(
      () => {
        nativeCalls += 1;
        return true;
      },
      () => deleteButton(root).click(),
    );
    expect(nativeCalls, 'native の confirm が呼ばれた(自前のダイアログに移っていない)').toBe(0);
    // ⚠ 確認は**出ている**(押すまで消えない)── 空振りでないことを併せて見る
    expect(dialogMessage(), '確認が出ていない').toContain('削除しますか');
    expect(d.getState().entryMetas.has('a'), '確認の前に消えた').toBe(true);
    await answerDialog('ok');
    expect(d.getState().entryMetas.has('a'), '受けたのに削除されない').toBe(false);
  });

  it('取り消したら、何も起きない(理由も出さない)', async () => {
    const { root, d } = rig();
    deleteButton(root).click();
    await answerDialog('cancel');
    expect(d.getState().entryMetas.has('a'), '取り消したのに消えた').toBe(true);
    expect(d.getState().error, '取り消しただけで理由が出た').toBeNull();
  });
});
