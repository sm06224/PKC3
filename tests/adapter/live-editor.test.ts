/** @vitest-environment happy-dom */
/**
 * 🔴 **1 面のライブエディタの配線**(2026-08-05。ライブエディタ S5。
 * 設計 doc `docs/development/live-editor-design-2026-08.md` §4 / §9)。
 *
 * ここで守るのは 4 つ:
 *
 * ① **既定は今日の 2 列**(user 裁定 = 設計 §9 論点 C:塊を跨ぐ Ctrl+Z が
 *    入るまで既定にしない)── 既定が入れ替わると全 user に影響する
 * ② 設定 `pkc3.editor-mode` = 'split' で 2 列に戻る(2 ペインは廃止しない)
 * ③ 🔴 **確定した本文が外へ出る**(`onBodyChange`)── ここが落ちると
 *    **画面は変わるのに保存されない**(いちばん静かな壊れ方)
 * ④ **分割が組めない本文では原文の編集欄へ退避**する ── 壊れた分割の上で
 *    行を差し替えると本文が壊れる
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { frontmatterLineCount } from '../../src/features/markdown/frontmatter';

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

function editing(body: string): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] })
    .state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  s = reduce(s, { type: 'START_EDIT' }).state;
  return s;
}

/**
 * ⚠ 2026-08-14: flag `editor.live` は設定 `pkc3.editor-mode` へ昇格した
 *   (#104 第 2 弾。既定 live)。getMode() は読むたびに保存を見るので、
 *   localStorage を書けば即効く(URL はもう読まない)。
 */
function setLive(on: boolean): void {
  localStorage.setItem('pkc3.editor-mode', on ? 'live' : 'split');
}
afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

/** worker の無い環境の同期経路(= happy-dom)でも `follower` は microtask で返る。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

interface Rig {
  root: HTMLElement;
  detail: DetailRenderer;
  bodies: string[];
}

function rig(body: string): Rig {
  const root = document.createElement('div');
  // ⚠ **document へ繋ぐ**。`follower` の callback は `isConnected` を見て
  //    早期 return する(外された後に描かない規律)ので、繋がないと**何も出ない**
  document.body.append(root);
  const bodies: string[] = [];
  const detail = new DetailRenderer(
    buildShell(root).detail,
    null,
    new MarkdownClient(),
    (b) => bodies.push(b),
  );
  detail.render(editing(body));
  return { root, detail, bodies };
}

const DOC = ['# 題', '', '最初の段落。', '', '次の段落。'].join('\n');

describe('ライブエディタ(1 面)の配線', () => {
  /**
   * ① 🔴 **既定は 1 面(ライブ)**(user 裁定 2026-08-08「既定でON」/
   * #104 第 2 弾)。⚠ setLive を**呼ばずに**確かめる ── 設定が無い環境
   * そのもの(flag `editor.live` を保存していた旧環境も、残骸が黙殺されて
   * ここへ落ちる = 挙動は同値)。既定が入れ替わると全 user に影響する。
   */
  it('① 既定は 1 面(ライブ)── 設定なしで live が開く', async () => {
    localStorage.removeItem('pkc3.editor-mode');
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).not.toBeNull();
    expect(r.root.querySelector('[data-pkc-region="editor-split"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="editor-body"]')).toBeNull();
    // 画面は**描画済み文書**(原文がそのまま出ているのではない)
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelector('h1')?.textContent).toContain('題');
  });

  /**
   * ② 🔴 **設定 'split' で今日の 2 列に戻る**(裁定の後半「設定で2ペイン編集は
   * できるようにする」── 2 ペインは廃止されていない)。
   */
  it('② 設定 split で 2 列(原文 | プレビュー)に戻る', async () => {
    setLive(false);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-region="editor-split"]')).not.toBeNull();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="editor-body"]')).not.toBeNull();
  });

  /**
   * 🔴 **2 ペインでは、文書の情報が原文欄にそのまま居る**(#304、2026-08-22)。
   *
   * ## なぜこれを pin するのか
   *
   * #304 は当初「**2 ペインには札が出ない = 動線が 1 つ消えている**」と読み、
   * 札を split 側にも描く案を推薦していた。⚠ **その前提が実装と食い違っていた** ──
   * `detail.ts` は `ta.value = open.body`(**生 body**)を入れるので、
   * frontmatter は**原文欄の先頭にそのまま見えていて、その場で書き替えられる**。
   * ⚠ 「2 ペイン側は剥がしている」という issue の記述も誤りで、
   *   剥がしているのは**プレビュー側**だけだった。
   *
   * 🔑 だから札は足さず、**マニュアルを両モードで正確に書く**側へ倒した。
   *   ⇒ その判断が立つのは「原文欄に居る」が真である間だけなので、ここで pin する。
   *   ⚠ いま**これを見ている test は 1 件も無かった** ── 剥がす変更が入っても
   *   緑のまま通り、マニュアルの記述だけが静かに嘘になる。
   *
   * 🔑 **画面に出るだけでは足りない** ── 書き替えが**保存まで届く**ことも見る
   *   (`UPDATE_OPEN_BODY` の配線)。見ないと「見えているのに保存されない」を
   *   見逃す(CLAUDE.md §2「本命の分岐を unit は 1 度も通らないことがある」)。
   */
  it('🔴 2 ペインの原文欄に文書の情報が居て、その場で書き替えられる (#304)', async () => {
    setLive(false);
    const body = '---\ntags: [買い物]\n---\n本文です\n';
    const r = rig(body);
    await settle();
    const ta = r.root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta, '2 ペインの原文欄が無い').not.toBeNull();
    // ① 生 body ── frontmatter が剥がされていない
    expect(ta!.value, '原文欄から文書の情報が剥がれている(札が無い動線の代わりが消える)').toBe(
      body,
    );
    // ② 剥がした側(プレビュー)と取り違えていないこと ── issue #304 の誤りは
    //    「2 ペインは剥がしている」だったが、剥がすのはプレビューだけである
    expect(
      r.root.querySelector('[data-pkc-region="editor-preview"]')?.textContent ?? '',
      'プレビューに文書の情報が漏れている(剥がす側が効いていない)',
    ).not.toContain('tags:');
    /**
     * ⚠ **書き替えが保存まで届くか**は、ここでは見ない ── 2 ペインの保存は
     *   **binder 経由**(`input` → `UPDATE_OPEN_BODY`)で、この rig は binder を
     *   繋いでいないので**必ず空振りする**。観測点を間違えたまま緑にしない。
     * 🔑 そちらは `tests/adapter/editor-mode.test.ts` が dispatcher ごと見る。
     */
  });

  /**
   * ⚠ **対照群** ── 1 面編集では逆に、frontmatter は**本文から外して**札が持つ。
   *   両方が同じ形になったら、どちらかの直しが片側へ漏れている。
   */
  it('⚠ 対照群 ── 1 面編集では札が持ち、本文の面には出さない', async () => {
    setLive(true);
    const r = rig('---\ntags: [買い物]\n---\n本文です\n');
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]');
    expect(card, '1 面編集で札が出ていない').not.toBeNull();
    expect(
      card?.querySelector('[data-pkc-field="fm-summary"]')?.textContent ?? '',
      '札に中身が出ていない',
    ).toContain('tags: 買い物');
  });

  it('③ 🔴 行を書き換えて確定すると、継ぎ足した本文が外へ出る', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value).toBe('最初の段落。');
    ta.value = '書き換えた。';
    ta.blur();
    // 🔴 **1 行だけ**が変わった本文が出る(他の行を潰していない)
    expect(r.bodies).toEqual([['# 題', '', '書き換えた。', '', '次の段落。'].join('\n')]);
    await settle();
    expect([...live.querySelectorAll('p')].map((e) => e.textContent)).toContain('書き換えた。');
  });

  it('③ 変えずに閉じたら本文は出ない(空の書込を投げない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!.blur();
    expect(r.bodies).toEqual([]);
    // ⚠ それでも穴は残っていない
    expect(live.querySelector('[data-pkc-row-slot]')).toBeNull();
    expect([...live.querySelectorAll('p')].map((e) => e.textContent)).toContain('最初の段落。');
  });

  it('④ 分割が組めない本文では原文の編集欄へ退避し、理由を出す', async () => {
    setLive(true);
    // ⚠ **直った形を使い続けない** ── 入れ子の `:::` も id 無しの figure も直った。
    //    いまの実物は「renderer が知らない名前」(走査器だけが囲いと見なす)
    // ⚠ **2026-08-07 に fixture を替えた。** 走査器が `directive-open.ts` の判定を
    //    引くようになり、知らない名前(`:::unknown-thing`)は**開くようになった**。
    //    いま組めないのは「名前は知っているが属性が不正で畳めない」形である
    const r = rig([':::figure{id="あ い"}', '', '本文', '', ':::', '', 'あと', ''].join('\n'));
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelector('[data-pkc-field="editor-body"]')).not.toBeNull();
    expect(live.querySelector('[data-pkc-field="row-source"]')).toBeNull();
    const note = r.root.querySelector('[data-pkc-field="row-note"]')!;
    expect(note.textContent).toContain('行ごとに編集できません');
  });

  it('④ 退避した原文欄の打鍵も外へ出る(退避先で保存が死んでいない)', async () => {
    setLive(true);
    const r = rig([':::figure{id="あ い"}', '', '本文', '', ':::', '', 'あと', ''].join('\n'));
    await settle();
    const ta = r.root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '普通の段落に直した。';
    ta.dispatchEvent(new Event('input'));
    expect(r.bodies).toEqual(['普通の段落に直した。']);
  });

  /**
   * 🔴 **ライブ面にも文書 globals が届く**(3 巡目レビューで穴が判明)。
   * `data-pkc-doc-align` を消費する面は 5 つ(読む面 / プレビュー / **ライブ** /
   * 添付の説明 / 書き出し)だが、当時は**ライブを誰も見ていなかった** ──
   * 渡し忘れの変異が全 test 緑で通る。添付の説明の pin は attachment-view.test.ts(#106)。
   * ⚠ しかもここは今回の入れ替え(`opposite` の反転)が**成立する前提**である ──
   *   届かなければ、`align: right` の文書をライブ編集している間だけ `|>` が
   *   読む面と逆に出る(CLAUDE.md「同じ値を複数の描画経路へ渡すものは経路ごとに pin」)。
   */
  it('🔴 ライブ面にも文書 globals(寄せ・書字方向)が届く', async () => {
    setLive(true);
    const r = rig(['---', 'align: right', 'direction: rtl', '---', '', '普通の段落', ''].join('\n'));
    await settle();
    const pane = r.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    expect(pane.getAttribute('data-pkc-doc-align'), '宣言した寄せがライブ面に届いていない').toBe(
      'right',
    );
    expect(pane.getAttribute('dir'), '書字方向がライブ面に届いていない').toBe('rtl');
    /**
     * 🔴 **class も見る**(4 巡目レビュー R2)。入れ替え規則は
     * `.pkc-md-rendered[data-pkc-doc-align=…] [data-pkc-align=…]` で、
     * **class と属性が揃って初めて当たる**。属性だけ見ていると
     * `pane.className = ''` の変異が生き延び、ライブ編集中は本文の CSS が
     * **丸ごと当たらない**(見出し・表・コード・寄せの全部)のに緑のままだった。
     */
    expect(
      pane.classList.contains('pkc-md-rendered'),
      'ライブ面が markdown の CSS の外に居る(属性だけ届いても寄らない)',
    ).toBe(true);
  });

  it('お知らせの行は常に同じ場所に在る(出ても配置が動かない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-field="row-note"]')).not.toBeNull();
  });

  it('🔴 塊を跨ぐ Ctrl+Z で 1 つ前の確定が戻る(S8。既定 ON の条件)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const open = (text: string): HTMLTextAreaElement => {
      const p = [...live.querySelectorAll('p')].find((e) => e.textContent === text)!;
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
      return live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    };
    // 2 か所を順に書き換える(= 塊を跨ぐ)
    const a = open('最初の段落。');
    a.value = '1 回目。';
    a.blur();
    await settle();
    const b = open('次の段落。');
    b.value = '2 回目。';
    b.blur();
    await settle();
    expect(r.bodies.at(-1)).toBe(['# 題', '', '1 回目。', '', '2 回目。'].join('\n'));

    // 🔴 行の外で Ctrl+Z ── 直前の確定だけが戻る
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await settle();
    expect(r.bodies.at(-1)).toBe(['# 題', '', '1 回目。', '', '次の段落。'].join('\n'));
    // もう 1 回で最初の確定も戻る
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await settle();
    expect(r.bodies.at(-1)).toBe(DOC);
    expect(live.textContent).toContain('最初の段落。');

    // やり直し(Ctrl+Shift+Z)
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    await settle();
    expect(r.bodies.at(-1)).toBe(['# 題', '', '1 回目。', '', '次の段落。'].join('\n'));
  });

  it('🔴 行の中の Ctrl+Z は奪わない(打鍵単位の取り消しは OS のもの)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    ta.value = '打ちかけ';
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    // 🔴 既定を止めていない = ブラウザ自前の取り消しが働く
    expect(ev.defaultPrevented, '行の中の Ctrl+Z を奪っている').toBe(false);
    // 確定もしていない(履歴の取り消しが割り込んでいない)
    expect(r.bodies).toEqual([]);
    expect(ta.value).toBe('打ちかけ');
  });

  it('戻せる編集が無いときは理由を出す(押しても何も起きない、にしない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(r.root.querySelector('[data-pkc-field="row-note"]')!.textContent).toContain(
      '取り消せる編集はありません',
    );
    expect(r.bodies).toEqual([]);
  });

  it('🔴 Ctrl+A で全文が 1 つの入力欄になる(S6。今日の編集画面の縮退形)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelectorAll('p')).toHaveLength(2);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value).toBe(DOC);
    expect(live.querySelectorAll('p')).toHaveLength(0);
    // 書き換えて確定すると本文が丸ごと入れ替わる
    ta.value = '# 作り直した';
    ta.blur();
    expect(r.bodies).toEqual(['# 作り直した']);
    await settle();
    expect(live.querySelector('h1')!.textContent).toBe('作り直した');
  });

  it('🔴 他の列で押した Ctrl+A / Ctrl+Z は奪わない(面の外の打鍵)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    // 左の列のボタンに焦点が在る状態を作る
    const outside = document.createElement('button');
    document.body.append(outside);
    for (const key of ['a', 'z']) {
      const ev = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      outside.dispatchEvent(ev);
      expect(ev.defaultPrevented, `面の外の Ctrl+${key} を奪っている`).toBe(false);
    }
    expect(r.root.querySelector('[data-pkc-field="row-source"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="row-note"]')!.textContent).toBe('');
    outside.remove();
  });

  it('行の中の Ctrl+A は奪わない(その行を選ぶブラウザ既定のまま)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    const ev = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented, '行の中の Ctrl+A を奪っている').toBe(false);
    expect(ta.value).toBe('最初の段落。'); // 全文に化けていない
  });

  it('🔴 「全文を編集」ボタンで全文が 1 つの入力欄になる(Ctrl+A の可視の導線)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const btn = r.root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]');
    expect(btn, 'ボタンが無い(キーを知らない人に届かない)').not.toBeNull();
    expect(btn!.disabled).toBe(false);
    expect(btn!.textContent).toBe('全文を編集');
    btn!.click();
    const ta = r.root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value).toBe(DOC);
    // 書き換えて確定すると本文が丸ごと入れ替わる(Ctrl+A と同じ口)
    ta.value = '# 作り直した';
    ta.blur();
    expect(r.bodies).toEqual(['# 作り直した']);
  });

  it('退避(行ごとに編集できない本文)では「全文を編集」は押せず、理由が読める', async () => {
    setLive(true);
    const r = rig([':::figure{id="あ い"}', '', '本文', '', ':::', '', 'あと', ''].join('\n'));
    await settle();
    const btn = r.root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!;
    expect(btn.disabled, 'すでに原文全体の編集なのに押せる').toBe(true);
    expect(btn.title).toContain('すでに原文全体');
  });

  /**
   * 🔴 **同じことをする双子(Ctrl+A)も塞ぐ**(2026-08-08 の 2 巡目レビュー)。
   * ボタンだけ `disabled` にして、**同じ `activateAll()` を撃つ打鍵**は素通りだった。
   * `swap.dispose()` は listener と active を落とすだけで `view` / `body` を残すので
   * `activateAll()` は**まだ呼べてしまい**、退避用の入力欄が入っている面を上書きする。
   * ⚠ 断り文は**ボタンに書いたものと同じ言葉**であること ── 押した場所が違っても
   *   理由が同じなら同じ言い方にする(言い換えると user は別のものを探す)。
   */
  it('🔴 退避後は Ctrl+A も塞がれ、ボタンと同じ言葉で断る(双子を残さない)', async () => {
    setLive(true);
    const r = rig([':::figure{id="あ い"}', '', '本文', '', ':::', '', 'あと', ''].join('\n'));
    await settle();
    const pane = r.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    const before = pane.querySelector('[data-pkc-field="editor-body"]')!.textContent;

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }),
    );

    const note = r.root.querySelector<HTMLElement>('[data-pkc-field="row-note"]')!;
    expect(note.textContent, 'ボタンと違う言い方で断っている').toContain('すでに原文全体');
    // ⚠ 面が上書きされていないこと ── 断り文だけ出して中身を壊していないか
    expect(
      pane.querySelector('[data-pkc-field="editor-body"]')?.textContent,
      '退避用の入力欄が上書きされた',
    ).toBe(before);
    expect(
      pane.querySelector('[data-pkc-field="row-source"]'),
      '退避中なのに行の入力欄が開いた',
    ).toBeNull();
    // 🔑 **ボタンと同じ言葉**であること自体を pin する(片方だけ言い回しを変える
    //    変異を止める ── substring 2 本では「同じ言葉」を守っていない)
    const editAll = r.root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!;
    expect(note.textContent, 'ボタンと断り文が別の言い回しになっている').toBe(editAll.title);
  });

  /**
   * 🔴 **退避後は Ctrl+Z / Ctrl+Y も塞ぐ**(3 巡目レビュー。**4 件目の双子**)。
   * ⚠ Ctrl+A より実害が大きい ── 退避先は follower が描き直さない面なので、
   *   journal を当てると **`body`(保存される値)だけが動いて画面が追随しない**。
   *   そのまま保存すると **user が見ていない本文が保存される**。
   */
  it('🔴 退避後は Ctrl+Z も塞がれ、本文(保存される値)が動かない', async () => {
    setLive(true);
    /**
     * ⚠ **fixture は「行編集を 1 回確定してから退避する」形でなければならない**
     * (4 巡目レビュー R4)。最初から分割できない本文を渡すと **journal がゼロ件**で、
     * ガードを外しても `undo` が null を返すだけ ── 下の ②③ が**ガードの有無に
     * 関わらず通る**(実際、`journal 非空のときだけガードを外す`変異が素通りした)。
     * 「fixture のゼロ件の次元は測っていない次元」そのものだった。
     */
    const r = rig(['普通の段落。', '', '二つめの段落。'].join('\n'));
    await settle();
    const live = r.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    const p0 = [...live.querySelectorAll('p')].find((e) => e.textContent === '普通の段落。')!;
    p0.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const row = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    // 確定すると journal に 1 件入り、その本文は分割できないので退避へ落ちる
    row.value = [':::figure{id="あ い"}', '', '中身', '', ':::'].join('\n');
    row.blur();
    await settle();

    const pane = r.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    const ta = pane.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta, '前提: 退避していない(fixture が効いていない)').not.toBeNull();
    // 🔑 **非ゼロ次元を test 自身に assert させる** ── 確定が 1 回起きた = journal が非空
    expect(r.bodies.length, '前提: 確定が起きていない(journal がゼロ件で空振りする)')
      .toBeGreaterThan(0);
    const shown = ta.value;
    const bodiesBefore = r.bodies.length;

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );

    const note = r.root.querySelector<HTMLElement>('[data-pkc-field="row-note"]')!;
    const editAllBtn = r.root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!;
    expect(note.textContent, '退避中の Ctrl+Z を断っていない').toContain('すでに原文全体');
    // 3 か所目も等値で ── 押した場所が違っても理由が同じなら言い方も同じ
    expect(note.textContent, 'ボタンと別の言い回しになっている').toBe(editAllBtn.title);
    expect(ta.value, '画面の入力欄が動いた').toBe(shown);
    expect(
      r.bodies.length,
      '画面が追随しないまま本文(保存される値)だけが動いた',
    ).toBe(bodiesBefore);
  });

  it('編集を抜けたら聴くのをやめる(外れた面が反応し続けない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    /**
     * ⚠ **取り消しの listener は `document` に張ってある**(焦点が本文の外に在る
     * 状態で来るので)。面を畳んだら外さないと、編集に入るたびに 1 つ積む。
     * `pane.isConnected` のガードが在るので**振る舞いでは見えない** ── 資源の話
     * なので、外したこと自体を観測点にする。
     */
    const off = vi.spyOn(document, 'removeEventListener');
    // 表示を閉じる(選択解除)── `cancelPreview` が `RowSwap.dispose()` を呼ぶ
    r.detail.render(
      reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state,
    );
    expect(
      off.mock.calls.some(([type]) => type === 'keydown'),
      '取り消しの listener を外していない(編集に入るたびに積む)',
    ).toBe(true);
    off.mockRestore();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).toBeNull();
    // 🔴 外れた面の中をクリックしても、入力欄は生えない(listener が残っていない)
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    expect(live.querySelector('[data-pkc-field="row-source"]')).toBeNull();
    expect(r.bodies).toEqual([]);
  });
});

/**
 * 🔴 **文書の情報(frontmatter)が、普通の編集で消えない**(#284)。
 *
 * ⚠ 直す前の実測:既定の live は**生の本文をそのまま描く**ので、
 *   `---` が水平線・`tags: [...]` が**見出し**として画面に出ていた。
 *   user から見れば「消してよさそうな謎の行」であり、その場で消せた ──
 *   閉じの `---` が 1 行消えるだけで `parseFrontmatter` は `{}` を返し、
 *   **警告 0 件でタグが全部消える**。
 * ⚠ しかも **live を frontmatter 付きで開く test が 1 本も無かった**ので、
 *   この挙動は全 test 緑のまま出荷されていた(CLAUDE.md §2)。
 *
 * 🔑 守る主張は 4 つ:
 * 1. 情報は**本文として描かれない**(謎の見出しが出ない)
 * 2. 情報は**札として見える**(隠すのではなく名札を付ける)
 * 3. 🔴 **行ごとの編集が、原文の正しい行を書き換える**(ずれない)
 * 4. 🔴 **情報を編集する口が在る**(触れなくしただけなら動線を 1 つ減らしている)
 */
describe('文書の情報(frontmatter)の扱い(#284)', () => {
  const FM = ['---', 'tags: [あ, い]', '---', '# 題', '', '最初の段落。'].join('\n');

  it('🔴 情報が本文として描かれない(謎の見出しが出ない)', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    // ⚠ 直す前は <hr> と <h2 id="tags-あ-い"> がここに出ていた
    expect(live.querySelector('hr'), '情報が水平線として本文に出ている').toBeNull();
    expect(
      [...live.querySelectorAll('h1,h2,h3')].map((e) => e.textContent),
      '情報が見出しとして本文に出ている',
    ).toEqual(['題']);
    // 空振り防止 ── 本文そのものは描けている
    expect([...live.querySelectorAll('p')].map((e) => e.textContent)).toContain('最初の段落。');
  });

  it('🔴 情報は札として見える(中身つき)', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    expect(card.hasAttribute('data-pkc-has-frontmatter'), '札が出ていない').toBe(true);
    expect(
      card.querySelector('[data-pkc-field="fm-summary"]')?.textContent,
      '何が入っているか出ていない',
    ).toContain('tags: あ, い');
  });

  it('情報の無い文書では札を出さない(空の枠を置かない)', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    expect(card.hasAttribute('data-pkc-has-frontmatter'), '情報が無いのに札が出た').toBe(false);
    expect(card.textContent, '空の札に文字が出ている').toBe('');
  });

  /**
   * 🔴 **札は「読めている」顔をしない**(#284 / #318、着地前レビュー G)。
   *
   * ⚠ 判定を `fmLines === 0` だけにしていたので、**二重 fence のノート**では
   *   `fmLines > 0` になり、札は 1 本目だけを出して自信満々に要約していた ──
   *   **同じノートで、右の情報ペインは「読めていません」**と言う。
   *   同じ問いに 2 つの答えが在る状態だった(CLAUDE.md §7)。
   * ⚠ 閉じが無い側(`fmLines === 0`)では、直す前は**札そのものが出なかった** ──
   *   つまり**いちばん直したい場所で黙っていた**。
   */
  it('🔴 読めていないときは、札が理由を出す(要約で嘘をつかない)', async () => {
    setLive(true);
    for (const [name, body, want] of [
      ['閉じが無い', '---\ntags: [あ]\n本文\n', '閉じの ---'],
      [
        'cap 超過',
        `---\nk: ${'あ'.repeat(20000)}\n---\n本文\n`,
        '大きすぎて',
      ],
    ] as const) {
      const r = rig(body);
      await settle();
      const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
      expect(card.hasAttribute('data-pkc-has-frontmatter'), `${name}: 札が出ていない`).toBe(true);
      expect(
        card.querySelector('[data-pkc-field="fm-label"]')?.textContent,
        `${name}: 読めているように見せている`,
      ).toBe('文書の情報が読めていません');
      expect(
        card.querySelector('[data-pkc-field="fm-problem"]')?.textContent ?? '',
        `${name}: 理由が出ていない`,
      ).toContain(want);
      // ⚠ 空振り防止 ── 要約(読めている顔)は出ていない
      expect(
        card.querySelector('[data-pkc-field="fm-summary"]'),
        `${name}: 読めていないのに要約が出ている`,
      ).toBeNull();
      /**
       * 🔴 **読めなくても、触れる所は残す**(2 巡目レビュー A-5)。
       * ⚠ 1 稿目は理由を出したら必ず `return` していたので、**cap を超えた
       *   frontmatter は 1 面編集から手が届かなくなっていた**(`docOf` が本文から
       *   隠すのに、`情報を編集` も出ない)。
       * ⚠ 閉じが無い側(`fmLines === 0`)は**壊れた行が本文にそのまま見えている**
       *   ので、そちらでは出さない(切り出す行が無く、編集器が空になる)。
       */
      const hasLines = frontmatterLineCount(body) > 0;
      expect(
        card.querySelector('[data-pkc-field="fm-edit"]') !== null,
        `${name}: 編集の口の有無が違う(隠れている情報に手が届かない)`,
      ).toBe(hasLines);
    }
  });

  /**
   * 🔴 **2 組目が残っているだけなら、1 組目は普通に扱う**(2 巡目レビュー A-2)。
   * ⚠ 1 稿目は要約も編集の口も消していたので、**健全なノートから唯一の編集導線が
   *   消えて**いた。
   */
  it('🔴 2 組目が残っていても、読めている 1 組目は要約と編集を出す', async () => {
    setLive(true);
    const r = rig('---\ntags: [あ]\n---\n\n---\n\nTODO: 明日やる\n');
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    expect(
      card.querySelector('[data-pkc-field="fm-summary"]')?.textContent,
      '読めている情報の要約が消えた',
    ).toContain('tags: あ');
    expect(card.querySelector('[data-pkc-field="fm-edit"]'), '編集の口が消えた').not.toBeNull();
    expect(
      card.querySelector('[data-pkc-field="fm-label"]')?.textContent,
      '読めているのに読めていないと言っている',
    ).toBe('この文書の情報');
    /**
     * ⚠ **理由も添える**(3 巡目レビュー MUT-E)── ここを見ていなかったので、
     *   A-2 の後半(「なぜ 2 組目が在るのか」を書く)を**落としても緑**だった。
     *   要約・編集の口だけ見ていると「普通のノートと同じ顔」で通ってしまい、
     *   user は**2 組目に気づけないまま**になる。
     */
    expect(
      card.querySelector('[data-pkc-field="fm-problem"]')?.textContent ?? '',
      '2 組目が残っている理由が出ていない',
    ).toContain('2 組目');
  });

  /**
   * 🔴 **これが本丸** ── 描く本文は情報を外した側なので、行番号が
   * `fmLines` だけずれる。ずらし忘れると **情報の行を書き潰す**
   * (user から見て「上の数行が消えた」)。
   */
  it('🔴 行を書き換えても、情報の行を書き潰さない', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value, '開いた行が原文とずれている').toBe('最初の段落。');
    ta.value = '書き換えた。';
    ta.blur();
    expect(r.bodies).toEqual([
      ['---', 'tags: [あ, い]', '---', '# 題', '', '書き換えた。'].join('\n'),
    ]);
  });

  /** ⚠ 見出し(情報のすぐ下の行)でも同じ ── 境目の 1 行で試す。 */
  it('🔴 情報のすぐ下の行を書き換えても、ずれない', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const h = live.querySelector('h1')!;
    h.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value, '境目の行がずれている').toBe('# 題');
    ta.value = '# 新しい題';
    ta.blur();
    expect(r.bodies).toEqual([
      ['---', 'tags: [あ, い]', '---', '# 新しい題', '', '最初の段落。'].join('\n'),
    ]);
  });

  /**
   * 🔴 **全文編集でも情報を巻き込まない**(#284)。⚠ ここが本文側に入っていると、
   *   「全文を編集」を押しただけで情報が入力欄に出てきて、消せてしまう。
   */
  it('🔴 「全文を編集」に情報は入らない', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    r.root.querySelector<HTMLElement>('[data-pkc-field="edit-all"]')!.click();
    const ta = live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value, '全文編集の入力欄に情報が入っている').not.toContain('tags:');
    expect(ta.value, '本文が入っていない(空振り)').toContain('# 題');
  });

  /**
   * 🔴 **情報を編集する口が在る**(#284)。⚠ 本文側から触れなくしたので、
   *   ここが無いと**書けたものが書けなくなる**(CLAUDE.md 不可侵)。
   */
  it('🔴 札から情報を編集して確定できる', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    card.querySelector<HTMLElement>('[data-pkc-field="fm-edit"]')!.click();
    const ta = card.querySelector<HTMLTextAreaElement>('[data-pkc-field="fm-source"]')!;
    expect(ta.value, '原文がそのまま出ていない').toBe('---\ntags: [あ, い]\n---');
    ta.value = '---\ntags: [う]\n---';
    card.querySelector<HTMLElement>('[data-pkc-field="fm-commit"]')!.click();
    expect(r.bodies.at(-1), '情報だけが差し替わっていない').toBe(
      ['---', 'tags: [う]', '---', '# 題', '', '最初の段落。'].join('\n'),
    );
    await settle();
    expect(
      r.root.querySelector('[data-pkc-field="fm-summary"]')?.textContent,
      '札が新しい値に追随していない',
    ).toContain('tags: う');
  });

  it('やめると本文は変わらない', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    card.querySelector<HTMLElement>('[data-pkc-field="fm-edit"]')!.click();
    card.querySelector<HTMLTextAreaElement>('[data-pkc-field="fm-source"]')!.value = '壊す';
    card.querySelector<HTMLElement>('[data-pkc-field="fm-cancel"]')!.click();
    expect(r.bodies, 'やめたのに本文が出た').toEqual([]);
    expect(card.querySelector('[data-pkc-field="fm-summary"]')?.textContent).toContain('tags: あ');
  });

  /**
   * 🔴 **読めている文書へ「読めなくなりました」と言わない**(#641 ①)。
   *
   * ⚠ 同じ鍵を 2 本書いた文書は **`meta` が読めている**ので、言うべきことは
   *   「無視されている行が在る」であって「読めなくなった」ではない。
   * ⚠ 直す前の判定は `why.kind === 'trailing'` という**種別の名指し**だったので、
   *   種別を 1 つ足した瞬間に**読めている側へ嘘をつく**方へ倒れた
   *   (CLAUDE.md「置き換えの作法」── 列挙する側は、足されたときに壊れる)。
   */
  it('🔴 同じ鍵が 2 本ある文書に「読めなくなりました」と言わない(#641 ①)', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    card.querySelector<HTMLElement>('[data-pkc-field="fm-edit"]')!.click();
    card.querySelector<HTMLTextAreaElement>('[data-pkc-field="fm-source"]')!.value =
      '---\ntags: [あ]\ntags: [い]\n---';
    card.querySelector<HTMLElement>('[data-pkc-field="fm-commit"]')!.click();
    const note = r.root.querySelector('[data-pkc-field="row-note"]')!;
    expect(note.textContent, '読めているのに「読めなくなりました」と言った').toBe(
      'この文書の情報を更新しました',
    );
  });

  /**
   * 🔴 **読めなくなったら、そう言う**(#284 の本題)。
   * ⚠ 本文は 1 文字も失われていない(原文に残る)が、**情報としては読めていない** ──
   *   ここで黙ると、user はタグが消えたことに気づけない。
   */
  it('🔴 閉じの --- を消したら、読めなくなったと画面に出る', async () => {
    setLive(true);
    const r = rig(FM);
    await settle();
    const card = r.root.querySelector('[data-pkc-region="live-frontmatter"]')!;
    card.querySelector<HTMLElement>('[data-pkc-field="fm-edit"]')!.click();
    card.querySelector<HTMLTextAreaElement>('[data-pkc-field="fm-source"]')!.value =
      '---\ntags: [あ]';
    card.querySelector<HTMLElement>('[data-pkc-field="fm-commit"]')!.click();
    const note = r.root.querySelector('[data-pkc-field="row-note"]')!;
    expect(note.textContent, '黙って読めなくなった').toContain('読めなくなりました');
    // ⚠ 書いたものは本文に残っている(消してはいない)
    expect(r.bodies.at(-1), '本文から消えた').toContain('tags: [あ]');
    await settle();
    /**
     * 🔴 **向きを裏返した**(着地前レビュー G、2026-08-22)。
     *
     * ⚠ 1 稿目はここで「札が**消える**」を pin していた ── 理由は
     *   「2 つ目の編集口になる」。心配は正しいが、**消すのは無言である** ──
     *   いちばん直したい場所(本文のすぐ上)で黙ることになり、#284 の症状そのもの。
     * 🔑 いまは**札は出るが、要約ではなく理由を出し、編集の口は持たない** ──
     *   心配だけを外し、知らせる働きは残す。
     * ⚠ 「検査の向きを裏返したら作法も裏返る」(CLAUDE.md §1)ので、
     *   **心配していた当のもの(編集口)を明示的に見る**。
     */
    expect(
      card.hasAttribute('data-pkc-has-frontmatter'),
      '読めなくなった所で札が消えた(いちばん直したい場所で黙っている)',
    ).toBe(true);
    expect(
      card.querySelector('[data-pkc-field="fm-problem"]')?.textContent ?? '',
      '理由が出ていない',
    ).toContain('閉じの ---');
    expect(
      card.querySelector('[data-pkc-field="fm-edit"]'),
      // ⚠ 理由は「読めない情報を編集させない」ではない(A-5 がそれを否定した)──
      //    この形は fmLines === 0 で、壊れた行が**本文にそのまま見えている**
      '編集口が出ている(切り出す行が無く、本文の側で直せる形)',
    ).toBeNull();
    expect(
      card.querySelector('[data-pkc-field="fm-summary"]'),
      '読めていないのに要約が出ている',
    ).toBeNull();
  });
});

/**
 * 🔴 **2 ペイン編集でも「ここから編集する」が「ここから」になる**(#596 C)。
 *
 * ⚠ 直す前は `editOpenAt` を読むのが **1 面(ライブ)の描画だけ**で、2 ペインの側は
 *   **1 度も読んでいなかった** ── 300 行のノートの真ん中の見出しを右クリックして
 *   押しても、開くのは**原文の先頭**だった(`Ctrl`+クリックにも前から在った穴)。
 * 🔑 **画面に出ている字は契約**である ──「ここから」と書いてある以上、守られていないと嘘になる。
 */
describe('2 ペイン編集の「ここから」(#596 C)', () => {
  /** ⚠ 行を数え直さず、**その位置から始まる字**で確かめる。 */
  const head = (ta: HTMLTextAreaElement): string =>
    ta.value.slice(ta.selectionStart).split('\n')[0] ?? '';

  function open2(body: string, atLine: number | null): HTMLTextAreaElement {
    setLive(false);
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail, null, new MarkdownClient(), () => {});
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a')],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
    s = reduce(s, { type: 'START_EDIT', ...(atLine === null ? {} : { atLine }) }).state;
    detail.render(s);
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta, '2 ペインの原文欄が出ていない(台の空振り)').not.toBeNull();
    return ta!;
  }

  const LONG = ['# 題', '', '前置き', '', '## 決定事項', '', '中身', '', '## つぎ', ''].join('\n');

  it('🔴 押した見出しの行から開く', () => {
    // ⚠ `editOpenAt` は **frontmatter を剥がした側**の行(ここでは frontmatter 無し)
    expect(head(open2(LONG, 4)), '押した見出しの行から開いていない').toBe('## 決定事項');
  });

  /**
   * 🔴 **対照群** ── 頼まなければ飛ばない(何でも飛ぶ作りではない)。
   *
   * ⚠ **`selectionStart === 0` で見ない**(1 稿目はそう書いて落ちた)──
   *   `.value` を代入した後の既定は**器が決める**(happy-dom は末尾に置く。実測 29)。
   *   🔑 器の既定を pin すると、**製品ではなく happy-dom を検める** test になる。
   *   だから見るのは「**狙った行へ行っていない**」ことにする。
   */
  it('🔴 **対照群** ── 行を渡さなければ、その見出しへは飛ばない', () => {
    expect(head(open2(LONG, null)), '行を渡していないのに見出しへ飛んだ').not.toBe('## 決定事項');
  });

  /**
   * 🔴 **frontmatter のぶんずらす**(#596 B で踏んだのと同じ罠)。
   * ⚠ `editOpenAt` は剥がした側の行、`ta.value` は**剥がしていない本文** ──
   *   ずらさないと、frontmatter を持つノートで**その行数だけ手前**が開く。
   */
  it('🔴 frontmatter があってもずれない', () => {
    const body = ['---', 'tags: [会議]', '---', ...LONG.split('\n')].join('\n');
    expect(head(open2(body, 4)), 'frontmatter のぶんずれている').toBe('## 決定事項');
  });

  it('⚠ 行が本文より後ろでも、編集には入れる(最後の行の先頭へ丸める)', () => {
    const ta = open2(LONG, 999);
    expect(ta.selectionStart, '丸めずに投げた / 範囲外へ出た').toBeLessThanOrEqual(ta.value.length);
  });
});
