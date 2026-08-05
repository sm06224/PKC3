/** @vitest-environment happy-dom */
/**
 * P8 段⑧: **追記機構と競合ロック**。
 *
 * > user 指示 2026-08-03「**追記型は今すぐ実装して、今のままだと、なんの意味もない /
 * > 編集競合は競合ロックと強制解放も念頭にしてください**」
 *
 * 🔴 段⑥ の追記は「編集画面を開いて末尾へ飛ぶ」だけで、5000 行のログでも毎回
 * 全文を textarea に載せていた。ここは**編集画面を通らない**経路である。
 *
 * 🔴 だから編集の draft と**2 本の経路が同じ本文を握る**。ロックが無いと:
 * 「追記を押す → 書込が飛ぶ → すかさず編集 → editor が古い body を掴む →
 *  追記が着く → 保存 → **追記が黙って消える**」。
 * ⚠ この test の本丸はそこ ── 「追記できる」だけを見ると、消える経路は素通りする。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * 実 UI 一式。⚠ `persistEntry` の完了を**手で握れる**ようにする ── 書込が
 * 飛んでいる窓(数十 ms)は、握れないと再現できない。PKC2 はこの桁の窓で
 * 実際にデータを失っている。
 */
function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => {
    detail.render(s);
    box.render(s);
  });
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  const disk = { ...bodies };
  /** null = すぐ完了 / 関数 = その解決を待つ(窓を開ける)。 */
  let gate: { release: () => void; fail: (e: unknown) => void } | null = null;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    persistEntry: async (e) => {
      if (gate) {
        const held = gate;
        await new Promise<void>((res, rej) => {
          held.release = res;
          held.fail = rej;
        });
      }
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  return {
    root,
    d,
    persisted,
    disk,
    q,
    /** 書込を止めて窓を開ける。返り値を呼ぶと通す / 落とす。 */
    hold(): { pass(): void; drop(): void } {
      gate = { release: () => undefined, fail: () => undefined };
      const held = gate;
      return {
        pass: () => {
          gate = null;
          held.release();
        },
        drop: () => {
          gate = null;
          held.fail(new Error('disk full'));
        },
      };
    },
  };
}

/** 追記欄に打って押す(実 UI と同じ順序)。 */
function type(q: <T extends HTMLElement>(s: string) => T | null, text: string): void {
  q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value = text;
}

describe('追記(P8 段⑧)', () => {
  it('🔴 打って押すと**編集画面を通らずに** disk へ着く', async () => {
    const { d, q, persisted } = setup([meta('log', 'textlog')], { log: '前の記録' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    expect(q('[data-pkc-field="append-form"]')!.hidden).toBe(false);

    type(q, '今日のできごと');
    q('[data-pkc-action="append-entry"]')!.click();
    await tick();

    // ① 🔴 **編集に入っていない**(ここが段⑥ との違いの本体)
    expect(d.getState().phase).toBe('ready');
    expect(q('[data-pkc-field="editor-body"]'), '編集画面が開いてしまっている').toBeNull();
    // ② disk に着いた
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.body).toMatch(
      /^前の記録\n\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n今日のできごと\n$/,
    );
    // ③ 画面の本文も追いついている
    expect(d.getState().openBody?.body).toBe(persisted[0]!.body);
    // ④ 欄は空(続けて打てる)
    expect(q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value).toBe('');
  });

  it('ノートは日時の見出しを足さない(構造は書く人のもの)', async () => {
    const { d, q, persisted } = setup([meta('a', 'text')], { a: '本文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    type(q, 'あとがき');
    q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    expect(persisted[0]!.body).toBe('本文\n\nあとがき\n');
  });

  it('🔴 **disk から読み直して**足す(画面が持つ古い本文を基底にしない)', async () => {
    // 別経路(toggle / 復元 / 別タブ)の書込を巻き戻さないための規律。
    // ⚠ 画面の openBody を基底にする実装だと、ここで `外から追加` が消える
    const s = setup([meta('log', 'textlog')], { log: '元' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    s.disk.log = '元\n\n外から追加'; // 画面が知らないうちに disk が進んだ
    type(s.q, '追記');
    s.q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    expect(s.persisted[0]!.body).toContain('外から追加');
  });

  it('空欄では何も起きない(押し間違いで空節を積まない)', async () => {
    const { d, q, persisted } = setup([meta('log', 'textlog')], { log: 'x' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    type(q, '   \n  ');
    q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    expect(persisted).toHaveLength(0);
    expect(d.getState().writeLock, 'ロックを掴んだまま').toBeNull();
    // 🔴 **ロックも取らず、エラーも出さない**。ここを reducer が見ていないと、
    // 空欄で押すたびに「追記する内容がありません」が出る(押し間違いを叱る UI)
    expect(d.getState().error, '空欄を押しただけで叱っている').toBeNull();
  });

  it('追記できない種類には欄を出さない', async () => {
    const { d, q } = setup([meta('f', 'attachment')], { f: '{}' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'f' });
    await tick();
    expect(q('[data-pkc-region="append"]')!.hidden).toBe(true);
  });

  it('Ctrl+Enter で送れる。⚠ 変換中(IME)の Enter では送らない', async () => {
    const { d, q, persisted } = setup([meta('log', 'textlog')], { log: 'x' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    const input = q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
    input.value = 'まだ変換中';
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    await tick();
    expect(persisted, '変換中の Enter で送ってしまっている').toHaveLength(0);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(persisted).toHaveLength(1);
  });

  it('選択が別のノートへ移ったら打ちかけを捨てる', async () => {
    const { d, q } = setup([meta('log', 'textlog'), meta('log2', 'textlog')], {
      log: 'a',
      log2: 'b',
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    type(q, 'log 宛てのつもり');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log2' });
    await tick();
    expect(q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value).toBe('');
  });
});

describe('🔴 競合ロック(P8 段⑧、user 指示 2026-08-03)', () => {
  it('🔴 書込中は編集に入れない ── ここが塞がっていないと追記が黙って消える', async () => {
    const s = setup([meta('log', 'textlog')], { log: '前の記録' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    const gate = s.hold();
    type(s.q, '追記した内容');
    s.q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    expect(s.d.getState().writeLock?.lid).toBe('log');

    // 窓の中で編集へ入ろうとする(ロックが無ければ入れてしまう)
    s.q('[data-pkc-action="start-edit"]')!.click();
    expect(s.d.getState().phase, '書込中に編集へ入れてしまった').toBe('ready');

    gate.pass();
    await tick();
    // 🔴 追記が生きている(ロックが無ければ、この後の保存で消えていた)
    expect(s.d.getState().openBody?.body).toContain('追記した内容');
    expect(s.d.getState().writeLock).toBeNull();
    // 解けたので今度は編集に入れる
    s.q('[data-pkc-action="start-edit"]')!.click();
    expect(s.d.getState().phase).toBe('editing');
  });

  it('🔴 編集中は追記できない(理由と出口が画面に出る)', async () => {
    const s = setup([meta('log', 'textlog')], { log: '元' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    s.q('[data-pkc-action="start-edit"]')!.click();
    await tick();

    // 欄ではなく**ロックの帯**が出る
    expect(s.q('[data-pkc-field="append-form"]')!.hidden).toBe(true);
    expect(s.q('[data-pkc-field="append-lock"]')!.hidden).toBe(false);
    expect(s.q('[data-pkc-field="append-lock-reason"]')!.textContent).toContain('編集中');
    // ⚠ **失わない出口が先**(保存して解放)── 破棄しか無い形にしない
    expect(s.q('[data-pkc-action="commit-edit"]')).not.toBeNull();

    // backstop: 直に投げても通らない
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'log', text: 'x', heading: null });
    await tick();
    expect(s.persisted, '編集中に裏で書けてしまった').toHaveLength(0);
  });

  it('🔴 失敗しても必ずロックが解ける(永久に追記できなくならない)', async () => {
    const s = setup([meta('log', 'textlog')], { log: '元' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    const gate = s.hold();
    type(s.q, '追記');
    s.q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    gate.drop();
    await tick();
    expect(s.d.getState().writeLock, '失敗でロックを握ったまま').toBeNull();
    expect(s.d.getState().error).toContain('追記');
    // ⚠ **打った内容が残っている**(「押したら消えたが保存されていない」を作らない)
    expect(s.q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value).toBe('追記');
  });

  it('🔴 強制解放したあと、遅れて着いた ack で本文が巻き戻らない', async () => {
    // ⚠ ここが世代(`lockGen`)の存在理由。解放しただけだと、飛んでいた書込の
    // ack が後から着いて、user が見ている本文を勝手に差し替える
    const s = setup([meta('log', 'textlog')], { log: '元' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    const gate = s.hold();
    type(s.q, '追記');
    s.q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    expect(s.q('[data-pkc-field="append-lock-reason"]')!.textContent).toContain('書き込んでいます');

    // 強制解放 → 編集して保存(user は先へ進んだ)
    s.d.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(s.d.getState().writeLock).toBeNull();
    s.q('[data-pkc-action="start-edit"]')!.click();
    s.d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '手で書き直した' });
    s.q('[data-pkc-action="commit-edit"]')!.click();
    await tick();

    // 遅れていた追記がここで着く
    gate.pass();
    await tick();
    // 🔴 **巻き戻っていない**(古い ack は世代違いで捨てられる)
    expect(s.d.getState().openBody?.body, '古い ack が本文を巻き戻した').toBe('手で書き直した');
  });

  it('🔴 強制解放は**打った内容を消さない**', async () => {
    const s = setup([meta('log', 'textlog')], { log: '元' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    s.hold();
    type(s.q, '消えたら困る');
    s.q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    s.d.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await tick();
    expect(s.q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value).toBe('消えたら困る');
  });

  it('書込中は 2 通目を受けない(基底の取り違えを作らない)', async () => {
    const s = setup([meta('log', 'textlog')], { log: '元' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    const gate = s.hold();
    type(s.q, '1 通目');
    s.q('[data-pkc-action="append-entry"]')!.click();
    await tick();
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'log', text: '2 通目', heading: null });
    gate.pass();
    await tick();
    expect(s.persisted).toHaveLength(1);
    expect(s.persisted[0]!.body).toContain('1 通目');
  });
});
