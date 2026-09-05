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
import { appPanes } from '../../src/adapter/ui/render/pane-visibility';
import { stubRevisionOps } from '../helpers/revision-stub';
import { answerDialog, dialogMessage } from './dialog-helper';

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
    bodyChars: null,
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
    setEntryParent: async () => {},
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
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

    // ① 🔴 **編集に入っていない**(ここが段⑥ との違いの本体)。
    //    ⚠ 面に依らない形で見る(2026-08-14、#104 第 2 弾)── editor-body だけを
    //    見ると、既定が live の今は編集に入っても null で**空振りのまま緑**になる
    expect(d.getState().phase).toBe('ready');
    expect(
      q('[data-pkc-region="editor-split"], [data-pkc-region="editor-live"]'),
      '編集画面が開いてしまっている',
    ).toBeNull();
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
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'log', text: 'x', heading: null, target: null });
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
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'log', text: '2 通目', heading: null, target: null });
    gate.pass();
    await tick();
    expect(s.persisted).toHaveLength(1);
    expect(s.persisted[0]!.body).toContain('1 通目');
  });
});

/**
 * 🔴 **面を開いても、打ちかけの追記は消えない**(user 目線レビュー U-1、2026-08-22)。
 *
 * ## 直す前に起きていたこと
 *
 * user はノートを読みながら追記欄に「明日 田中さんに確認」と打つ。日付を確かめたく
 * なって **アプリ** → **カレンダー** を押し、見てから本文へ戻る。
 * ⇒ **追記欄が空になっている。** 確認も、お知らせも、1 行も出ない。
 *
 * ⚠ 原因は `appendModeOf` が `viewMode !== 'detail'` で `hidden` を返すこと
 *   (`append-box.ts:39`)と、render が `hidden` を「**別のノートへ移った**」と
 *   数えていたこと。カレンダー / かんばん / 集計 / 2 ペイン / 設定 / フラグ /
 *   **ヘルプ**のどれでも起きた。
 * ⚠ マニュアル §4 は「**書きながらマニュアルを読んだり**」をヘルプが編集中でも
 *   開ける理由に挙げている ── その**ヘルプを開くと打ちかけが消えて**いた。
 * ⚠ しかも `main.ts:470` は「同じ器に入れると打ちかけの文字も focus も消える」と
 *   書いて器を分けている。**分けた器が、面の切替で消していた。**
 *
 * 🔑 **対照群を同じ describe に置く** ── 「別のノートへ移ったら捨てる」ほうは
 *   守られていること。片方だけ見ると「全部残す」に倒す変異が生き延びる。
 */
describe('🔴 打ちかけの追記(user 目線レビュー U-1)', () => {
  const draft = (s: { q: <T extends HTMLElement>(x: string) => T | null }): string =>
    s.q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')?.value ?? '';

  it('🔴 面を開いて戻っても、打ちかけがそのまま残る', async () => {
    const s = setup([meta('log', 'textlog')], { log: '前の記録' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    type(s.q, '明日 田中さんに確認');
    // ⚠ 面はどれでも同じ経路 ── 代表 3 つを通す(ヘルプは「読みながら書く」の当事者)
    for (const mode of ['query', 'help', 'dual'] as const) {
      s.d.dispatch({ type: 'SET_VIEW_MODE', mode });
      await tick();
      s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
      await tick();
      expect(draft(s), `${mode} を開いたら打ちかけが消えた`).toBe('明日 田中さんに確認');
    }
  });

  it('⚠ 対照群 ── 別のノートを選んだら捨てる(別のノートへ書かないため)', async () => {
    const s = setup([meta('log', 'textlog'), meta('log2', 'textlog')], { log: 'あ', log2: 'い' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    type(s.q, '書きかけ');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log2' });
    await tick();
    expect(draft(s), '別のノートへ打ちかけが持ち越された').toBe('');
  });

  it('⚠ 対照群 ── 面をまたいで別のノートを選んでも捨てる(隠れている間に移った)', async () => {
    const s = setup([meta('log', 'textlog'), meta('log2', 'textlog')], { log: 'あ', log2: 'い' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    type(s.q, '書きかけ');
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    await tick();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log2' });
    await tick();
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    await tick();
    expect(draft(s), '隠れている間に移ったのに持ち越された').toBe('');
  });
});

/**
 * 🔴 **追記欄を畳んでいても、書込が返らないときの最後の出口(強制解放)は押せる所に出る**
 * (#609。user 裁定 2026-09-04)。
 *
 * ## 物語
 *
 * 追記を送った直後に「閲覧に戻ろう」と帯を押して欄を畳む(または `Alt+\`)。
 * その書込が返ってこない ── 畳む規則は器ごと `display: none` にするので、帯の中の
 * 「強制解放」も一緒に消えると、**追記できない状態から抜ける口が 0 になる**
 * (#609 の「畳むと入口が 0 になる操作」の 1 つ。⚠ 強制解放には鍵もパレットの行も
 * 無いので、この帯が**唯一の入口**である)。⚠ 同じ `writing` はタイル設定の書込
 * (`tileWrite`)でも立つので、追記欄を 1 度も触っていない人にも起きる。
 *
 * ## 何を見るか
 *
 * いまこれが成り立っているのは #655 ④ の CSS(`append-lock` が `hidden` でなければ
 * 畳んでいても器を出す)のおかげで、その規則の**条件**を満たすのは描画器の側である。
 * 規則そのものは `pane-visibility.test.ts` が pin するので、ここでは
 * ①書込中に条件が立つこと(帯と強制解放が `hidden` でない)②畳みの記録は動かない
 * (`hidden-panes` に `append` が残る)③押した先が同じ action で、打った字が残ること、
 * を実 UI で見る。⚠ happy-dom は `:has()` を正しく評価しない(`hidden` でも一致する
 * ── 実測)ので、規則を `matches` で当てずに条件の部品を見る。
 * ⚠ 対照群 ── 普通(`ready`)のときは帯が `hidden` なので条件は立たず、畳んだままである
 *   (これが無いと「帯を常に出す」変異と区別がつかない)。
 */
describe('🔴 畳んでいても最後の出口は消えない(#609)', () => {
  it('🔴 追記欄を畳んだまま書込が返らないとき、強制解放が出る条件が立ち、押すと同じ action が飛ぶ', async () => {
    const s = setup([meta('log', 'textlog')], { log: '元' });
    // ⚠ `toggle-pane` は `closest('[data-pkc-slot="root"]')` で器を探す ── 無いと
    //    `document.body` に落ち、**前の it が残した別の shell** に属性を書く
    s.root.setAttribute('data-pkc-slot', 'root');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    const shell = s.q('[data-pkc-region="shell"]')!;
    const lockBar = s.q('[data-pkc-field="append-lock"]')!;
    const grip = s.q<HTMLButtonElement>('[data-pkc-action="toggle-pane"][data-pkc-pane="append"]')!;
    try {
      // 送る → 書込が飛んだまま返らない
      s.hold();
      type(s.q, '追記');
      s.q('[data-pkc-action="append-entry"]')!.click();
      await tick();
      expect(s.d.getState().writeLock?.lid, '前提: 書込中になっていない').toBe('log');

      // その間に帯を押して畳む(実 UI と同じ口)
      grip.click();
      expect(shell.getAttribute('data-pkc-hidden-panes'), '前提: 畳めていない').toBe('append');

      // ① 条件が立つ ── 帯も強制解放も `hidden` でない(CSS が器を出す)
      expect(lockBar.hidden, '書込中なのに出口の帯が hidden').toBe(false);
      const release = s.q<HTMLButtonElement>('[data-pkc-action="force-release"]')!;
      expect(release.hidden, '書込中なのに強制解放が hidden').toBe(false);
      // ⚠ 帯の**中**に在ること ── 外へ出すと CSS の条件(帯が出ている)と器が別物になる
      expect(release.closest('[data-pkc-field="append-lock"]')).toBe(lockBar);
      // ② 畳みの記録は動いていない(黙って開いて済ませる形にしない)
      expect(appPanes.getHidden()).toEqual(['append']);

      // ③ 押す → 確認 → 同じ action(`FORCE_RELEASE_LOCK`)で解ける。打った字は残る
      release.click();
      expect(dialogMessage()).toContain('強制的に打ち切ります');
      await answerDialog('ok');
      await tick();
      expect(s.d.getState().writeLock, '強制解放が届いていない').toBeNull();
      expect(s.q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value).toBe('追記');

      // 対照群 ── 解けて `ready` に戻ったら帯は hidden(条件は立たず、畳んだまま)
      expect(lockBar.hidden, 'ready なのに帯が出ている(常に出す形になっている)').toBe(true);
      expect(shell.getAttribute('data-pkc-hidden-panes')).toBe('append');
    } finally {
      // ⚠ `appPanes` は file 内で共有 ── 畳みを残すと後の it が別の理由で落ちる
      appPanes.setHidden([]);
    }
  });
});
