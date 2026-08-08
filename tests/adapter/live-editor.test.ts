/** @vitest-environment happy-dom */
/**
 * 🔴 **1 面のライブエディタの配線**(2026-08-05。ライブエディタ S5。
 * 設計 doc `docs/development/live-editor-design-2026-08.md` §4 / §9)。
 *
 * ここで守るのは 4 つ:
 *
 * ① **既定は今日の 2 列**(user 裁定 = 設計 §9 論点 C:塊を跨ぐ Ctrl+Z が
 *    入るまで既定にしない)── 既定が入れ替わると全 user に影響する
 * ② `?pkc-flag=editor.live` で**1 面**になる(2 列の原文欄は出ない)
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
 * ⚠ `location.search` は `history.replaceState` で変える ── グローバルを
 * 丸ごと差し替えない(CLAUDE.md「必要な静的メソッドだけ」)。
 */
function setLive(on: boolean): void {
  // ⚠ 2026-08-07: `?pkc-live=1` は flag へ昇格した(user 指示「クエリパラメータを
  //    抜け穴にしてはいけない」)── 綴りは `?pkc-flag=editor.live` になった
  history.replaceState(null, '', on ? '/?pkc-flag=editor.live' : '/');
}
afterEach(() => setLive(false));

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
  it('① 既定は今日の 2 列(原文 | プレビュー)── 勝手に入れ替わっていない', async () => {
    setLive(false);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-region="editor-split"]')).not.toBeNull();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="editor-body"]')).not.toBeNull();
  });

  it('② `?pkc-flag=editor.live` で 1 面になり、2 列の原文欄は出ない', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    expect(r.root.querySelector('[data-pkc-region="editor-live"]')).not.toBeNull();
    expect(r.root.querySelector('[data-pkc-region="editor-split"]')).toBeNull();
    expect(r.root.querySelector('[data-pkc-field="editor-body"]')).toBeNull();
    // 画面は**描画済み文書**(原文がそのまま出ているのではない)
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelector('h1')?.textContent).toContain('題');
  });

  it('③ 🔴 行を書き換えて確定すると、継ぎ足した本文が外へ出る', async () => {
    setLive(true);
    const r = rig(DOC);
    await settle();
    const live = r.root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
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
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
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
   * `data-pkc-doc-align` を消費する面は 4 つ(読む面 / プレビュー / **ライブ** / 書き出し)
   * だが、**ライブだけ誰も見ていなかった** ── 渡し忘れの変異が全 test 緑で通る。
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
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
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
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
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
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
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
    p0.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
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
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(live.querySelector('[data-pkc-field="row-source"]')).toBeNull();
    expect(r.bodies).toEqual([]);
  });
});
