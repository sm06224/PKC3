/** @vitest-environment happy-dom */
/**
 * 🔴 **その場で計算**(#764)の**繋がり**を見る。
 *
 * 規則そのもの(何を式と読むか / 答えの字)は
 * `tests/features/inline-calc.test.ts` が見ている ── ⚠ **ここが見るのは配線**
 * である:本文の欄で `Enter` を押したとき、
 * ①欄の字が変わるか ②**state に届くか**(届かないと保存で消える)
 * ③**改行も起きるか**(`Enter` の意味を奪っていないか)。
 *
 * ⚠ 規則の test だけでは、**押しても何も起きない**実装が緑で通る
 *   (PKC2 は評価器しか test しておらず、検出器の穴を出荷した ── CLAUDE.md §2)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  // ⚠ 追記欄は `detail` 面の**外**に在る(`shell.ts` で兄弟)── 組まないと
  //    「追記欄でも計算する」を 1 度も通らない(CLAUDE.md §2)
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => {
    detail.render(s);
    box.render(s);
  });
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => body,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  return { root, d, q };
}

/**
 * 本文の欄を開き、末尾にカーソルを置いて `Enter` を押す。
 * @returns 欄と、`preventDefault` が呼ばれたか(= 改行を止めたか)
 */
async function pressEnter(body: string) {
  const { d, q } = setup(body);
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await tick();
  q('[data-pkc-action="start-edit"]')!.click();
  await tick();
  const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
  ta.value = body;
  ta.setSelectionRange(body.length, body.length);
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  await tick();
  return { ta, d, prevented: ev.defaultPrevented };
}

/**
 * 🔴 **追記欄でも計算する**(2026-09-07、着地前の動線レビュー)。
 *
 * ⚠ 1 稿目は `editor-body` / `row-source` の 2 つしか見ておらず、**追記欄で
 *   打つと無音**だった ── 裁定は「**PKC2と同じで！**」で、PKC2 は
 *   `isInlineCalcTarget` が追記の欄を名指しで許している。
 * ⚠ 追記欄は「本文を開かずに済ませる」いちばん短い動線で、家計や作業ログの
 *   ような**数を書く用途そのもの**である。
 */
/**
 * 🔴 **既定の編集画面(1 面のライブエディタ)でも計算する**
 * (2026-09-07、着地前の実装レビュー)。
 *
 * ⚠ 1 稿目は unit も smoke も **2 列(split)固定**で、`row-source` の経路を
 *   1 度も通っていなかった ── ⚠ **既定は live** なので
 *   (`src/features/editor-mode.ts` の `DEFAULT_EDITOR_MODE`)、
 *   **いちばん多くの user が触る経路が 0 件**だった(CLAUDE.md §2)。
 * 🔑 配線から `row-source` を落とす変異は、split だけ見る test を**素通りする**。
 */
describe('1 面のライブエディタでも計算される(#764)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'live');
  });

  it('🔴 行の欄で Enter を押すと答えが入り、確定すると本文に残る', async () => {
    const { d, q, root } = setup('見積もり');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick(30); // 描画は follower(microtask)── 1 拍待つ
    const live = root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '見積もり')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    ta.value = '見積もり 1200*1.1=';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(ta.value, '既定の編集画面で計算が届いていない').toBe('見積もり 1200*1.1=1320');
    // 🔴 行は `blur` で確定する ── ここが切れていると、画面に見えているのに本文に無い
    ta.blur();
    await tick();
    expect(d.getState().openBody?.body).toContain('1200*1.1=1320');
  });
});

describe('追記欄で Enter を押しても計算される(#764)', () => {
  // ⚠ 追記欄は編集の面の外に在るので、どちらの編集画面でも同じである
  //    ── それでも明示する(前の describe の後片付けに寄りかからない)
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'live');
  });

  async function pressInAppend(text: string) {
    const { d, q } = setup('# ログ\n');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
    ta.value = text;
    ta.setSelectionRange(text.length, text.length);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await tick();
    return { ta, prevented: ev.defaultPrevented };
  }

  it('🔴 追記欄の Enter で答えが入る', async () => {
    const { ta } = await pressInAppend('昼 800+250=');
    expect(ta.value).toBe('昼 800+250=1050');
  });

  it('🔴 引用の継ぎ足しは追記欄では起こさない(欄の集合が違う)', async () => {
    // ⚠ 対照群 ── 計算を追記欄へ広げたついでに、引用まで広げていないこと
    const { ta, prevented } = await pressInAppend('> ひきよう');
    expect(ta.value).toBe('> ひきよう');
    expect(prevented, '追記欄で引用を継ぎ足している').toBe(false);
  });
});

describe('本文で Enter を押すと計算される(#764)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });

  it('🔴 欄と state の両方に答えが入る', async () => {
    const { ta, d } = await pressEnter('請求は 1200*1.1=');
    // ① 欄の字
    expect(ta.value).toBe('請求は 1200*1.1=1320');
    // ② 🔴 state ── ここが繋がっていないと、保存した瞬間に答えが消える
    expect(d.getState().openBody?.body).toBe('請求は 1200*1.1=1320');
    // ③ カーソルは答えの後ろ(続けて打てる)
    expect(ta.selectionStart).toBe('請求は 1200*1.1=1320'.length);
  });

  it('🔴 改行は止めない(Enter の意味を奪わない)', async () => {
    const { prevented } = await pressEnter('2+3=');
    expect(prevented, '計算のために Enter を食べてはいけない').toBe(false);
  });

  it('🔴 引用の中でも計算し、引用の継ぎ足しも効く', async () => {
    // ⚠ 2 つの仕掛けが同じ Enter に乗る ── 計算が先、継ぎ足しが後
    const { ta, prevented } = await pressEnter('> 2+3=');
    expect(ta.value).toBe('> 2+3=5\n> ');
    expect(prevented, '継ぎ足しは自分で改行を書くので止める').toBe(true);
  });

  it('⚠ 式でないところでは何も足さない', async () => {
    const { ta, d, prevented } = await pressEnter('締切=');
    expect(ta.value).toBe('締切=');
    expect(d.getState().openBody?.body).toBe('締切=');
    expect(prevented).toBe(false);
  });

  it('🔴 打っていない字を足さない(PKC2 が `1,000=0` と書き込んだ形)', async () => {
    const { ta } = await pressEnter('会費は 1,000=');
    expect(ta.value).toBe('会費は 1,000=');
  });

  /**
   * ⚠ **選んでいる所は `=` の直後から始める**(2026-09-07、変異試験 M12 が
   *   SURVIVED で教えた)。1 稿目は行の先頭から選んでいたが、それだと
   *   カーソルの直前が `=` ではないので**門を外しても発火しない** ── 守っている
   *   ものが「選択の門」ではなく「`=` の門」だった(CLAUDE.md §1)。
   * 🔑 門でしか止まらないのは、**選択の始まりがちょうど `=` の直後**のときである
   *   ── そこで撃つと、`insertText` が**選んだ字を答えで置き換えて消す**。
   */
  it('⚠ 字を選んでいるときは撃たない(その Enter は置き換えの合図)', async () => {
    const { d, q } = setup('2+3=まちがい');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '2+3=まちがい';
    ta.setSelectionRange(4, 8); // 「まちがい」を選んでいる(始まりは `=` の直後)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(ta.value, '選んだ字が答えで消された').toBe('2+3=まちがい');
  });

  it('⚠ 変換中の Enter では撃たない(日本語で打つ人が毎回踏む)', async () => {
    const { d, q } = setup('けいさん 2+3=');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = 'けいさん 2+3=';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        // ⚠ happy-dom は init の `isComposing` をそのまま返す(2026-09-07 実測)
        isComposing: true,
      }),
    );
    await tick();
    expect(ta.value).toBe('けいさん 2+3=');
  });
});
