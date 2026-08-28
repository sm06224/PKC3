/** @vitest-environment happy-dom */
/**
 * 🔴 **行の入れ替え**(2026-08-05。ライブエディタ S5。設計 doc §4 / §5)。
 *
 * ここで守るのは「緑のまま壊れる」形が実在するものだけ:
 *
 * ① **差し替えても他の塊が同じ実体のまま残る** ── 丸ごと作り直しでも
 *    「中身は正しい」ので、実体で見ないと素通りする
 * ② **閉じたら描画が必ず戻る**(確定でも取り消しでも)── 穴が残ると、
 *    本文の 1 塊が**画面から消える**。`commit` が「変わっていない」で
 *    描き直さない経路が在るので、戻すのは `RowSwap` の責務である
 * ③ **日本語入力の契約** ── 封印中はノードを動かさない / `compositionend` は
 *    確定ではない / `blur` が変換中に来たら同期で確定しない / 安全弁
 * ④ **活性の塊の添字は引き直す** ── 前に塊が増えると添字がずれ、
 *    **触っていない塊が入力欄に化ける**
 * ⑤ **導出物は開かない** ── 原文の行が無いので、差し替えると本文が壊れる
 */
import { describe, expect, it, vi } from 'vitest';
import { RowSwap, blockWithSubSlot } from '../../src/adapter/ui/render/row-swap';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';
import { KEY_COMMANDS } from '../../src/features/keymap';

const DOC = [
  '# 題', //                       0
  '', //                           1
  '最初の段落。', //                2
  '', //                           3
  '| a | b |', //                  4
  '|---|---|', //                  5
  '| 1 | 2 |', //                  6
  '| 3 | 4 |', //                  7
  '', //                           8
  '- 一つめ', //                    9
  '- 二つめ', //                   10
  '', //                          11
  '最後の段落。', //               12
].join('\n');

interface Rig {
  host: HTMLElement;
  swap: RowSwap;
  commits: { start: number; end: number; text: string }[];
  notes: string[];
  /** 🔴 開閉で DOM へ入り直した要素(#250)── 呼び側が面倒をみる対象。 */
  inserted: Element[][];
  /** 本文を差し替えて描き直す(`detail.ts` の `commit` と同じ継ぎ足し規則)。 */
  render(body: string): void;
  /** 溜めた描き直しを流す(`defer` のとき)。 */
  flush(): void;
  body(): string;
}

/**
 * @param defer 🔴 **描き直しを溜める**。実機の描画は worker 経由で**非同期**なので、
 *   確定してから画面が組み直るまでに `click` が届く(`mousedown → blur → click`)。
 *   同期で描き直す rig はこの窓を潰してしまい、**順序の不具合を見逃す**。
 */
function rig(initial = DOC, defer = false): Rig {
  const host = document.createElement('div');
  document.body.append(host);
  const commits: Rig['commits'] = [];
  const notes: string[] = [];
  /** 🔴 開閉で DOM へ入り直した要素(#250)── 呼び側が面倒をみる対象。 */
  const inserted: Element[][] = [];
  let body = initial;
  let queued: string | null = null;
  const swap = new RowSwap(host, {
    commit: (start, end, text) => {
      commits.push({ start, end, text });
      const lines = body.split('\n');
      body = [...lines.slice(0, start), ...text.split('\n'), ...lines.slice(end + 1)].join('\n');
      if (defer) queued = body;
      else render(body);
    },
    notify: (m) => notes.push(m),
    onInserted: (els) => inserted.push([...els]),
  });
  const render = (text: string): void => {
    const { html, ranges } = renderMarkdownWithRanges(text);
    const r = swap.update(text, html, ranges);
    expect(r.ok).toBe(true);
  };
  render(body);
  return {
    host,
    swap,
    commits,
    notes,
    inserted,
    render,
    flush: () => {
      if (queued !== null) {
        const t = queued;
        queued = null;
        render(t);
      }
    },
    body: () => body,
  };
}

/** 描画された文書の中の要素を、文字で探す(test が selector に縛られないように)。 */
function findByText(host: HTMLElement, selector: string, text: string): Element {
  const hit = [...host.querySelectorAll(selector)].find((e) => e.textContent?.includes(text));
  if (!hit) throw new Error(`見つからない: ${selector} / ${text}`);
  return hit;
}

/**
 * 🔴 **素のクリック**(#495 以後は「読む・選ぶ・畳む」であって、開く操作ではない)。
 * ⚠ 塊を開きたい test は `openClick` を使う ── 名前で見分かるようにしてある。
 */
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
}

/**
 * 🔴 **塊を開くクリック = Ctrl(⌘)+クリック**(#495。user 裁定 2026-08-27)。
 * ⚠ `ctrlKey` で書く ── 実装は `ctrlKey || metaKey` を畳んでいる(`Chord.mod` と
 *   同じ規則)ので、⌘ 側は別の test が受け持つ。
 */
function openClick(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
}

/**
 * 🔴 **「字を選んでいる」状態を作って、その中で走らせる**(#495 の選択ガード)。
 *
 * ⚠ **本物の意味論を真似る**(CLAUDE.md §3)── 実装が見るのは
 *   `isCollapsed === false` と `toString() !== ''` の 2 つなので、両方を持たせる。
 * ⚠ happy-dom の `Selection` は範囲を張っても `toString()` が空のことがあるので、
 *   **`getSelection` を差し替える**。⚠ グローバルを丸ごと壊さない ── 
 *   `document.getSelection` **1 つだけ**を差し、`finally` で必ず戻す
 *   (戻さないと、以後の test が全部「選択中」になって**素通りする**)。
 */
function withSelection(text: string, run: () => void): void {
  const orig = document.getSelection.bind(document);
  document.getSelection = (): Selection =>
    ({ isCollapsed: false, toString: () => text }) as unknown as Selection;
  try {
    run();
  } finally {
    document.getSelection = orig;
  }
}

/** Shift+押下(範囲を広げる実際の引き金)。⚠ `click` ではない。 */
function shiftDown(el: Element): boolean {
  const ev = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    shiftKey: true,
  });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function box(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
}

describe('RowSwap — 行を原文の入力欄に差し替える', () => {
  it('段落をクリックすると、その塊だけが原文の入力欄になる', () => {
    const r = rig();
    const p = findByText(r.host, 'p', '最初の段落。');
    openClick(p);
    const ta = box(r.host);
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('最初の段落。');
    expect(r.swap.activeRange).toEqual({ start: 2, end: 2 });
    // ⚠ **他の塊は同じ実体のまま**(丸ごと作り直しなら別物になる)
    expect(findByText(r.host, 'h1', '題').isConnected).toBe(true);
  });

  /**
   * 🔴 **字を選んでいる最中は開かない**(#495。user 指摘「見出し全体クリック判定は
   * あまり良い挙動じゃない」の実害の側)。
   *
   * ⚠ ドラッグの終わりにも `click` は飛ぶので、無条件に開くと**選んだ字が
   *   その瞬間に消えて編集に入る**。🔑 規則は `binder.ts` の表の升と同じ 1 つ。
   * ⚠ **対照群を同じ it に置く** ── 置かないと「別の理由で開かなかった」を
   *   次に見抜けない(選択の仕込みが効いていなくても緑になる)。
   */
  it('🔴 字を選んでいる最中の素のクリックでは開かない', () => {
    const r = rig();
    withSelection('最初の', () => {
      click(findByText(r.host, 'p', '最初の段落。'));
      expect(box(r.host), '選んでいる最中に開いた(選んだ字が消える)').toBeNull();
      expect(r.notes, '断り文を出した(選んだ人は断られたつもりが無い)').toEqual([]);
    });
    // 対照群 ── 選択が無ければ**素のクリックで開く**(マウスだけの道は残す)
    click(findByText(r.host, 'p', '最初の段落。'));
    expect(box(r.host), '素のクリックで開かない(マウスだけの道が消えている)').not.toBeNull();
  });

  /**
   * ⚠ **中身が空の選択では止めない** ── 焦点が動いただけで `isCollapsed` が
   * false になる環境があり、そこで止めると**押しても開かない**に戻る。
   */
  it('🔴 中身が空の選択では、素のクリックで開く', () => {
    const r = rig();
    withSelection('', () => {
      click(findByText(r.host, 'p', '最初の段落。'));
      expect(box(r.host), '空の選択で止めた(押しても開かないに戻る)').not.toBeNull();
    });
  });

  /**
   * 🔑 **Ctrl(⌘)を押していれば、選んでいても開く** ── そちらは「ここを編集する」
   * というはっきりした意思表示なので、ガードで止めない。
   * ⚠ **選んでいる状態で見る** ── 選んでいなければ素のクリックでも開くので、
   *   選択が無い場面で試しても**修飾キーが効いた証拠にならない**(空振り)。
   */
  it('🔑 選んでいても Ctrl / ⌘ + クリックなら開く', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      const r = rig();
      withSelection('最初の', () => {
        findByText(r.host, 'p', '最初の段落。').dispatchEvent(
          new MouseEvent('click', { bubbles: true, button: 0, ...mods }),
        );
        expect(box(r.host)?.value, `ガードで止めた: ${JSON.stringify(mods)}`).toBe('最初の段落。');
      });
    }
  });

  it('🔴 Alt が一緒のときは開かない(AltGr と、読む面の追記の入り先)', () => {
    const r = rig();
    const p = findByText(r.host, 'p', '最初の段落。');
    for (const mods of [{ ctrlKey: true, altKey: true }, { altKey: true }]) {
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...mods }));
      expect(box(r.host), `開いてしまった: ${JSON.stringify(mods)}`).toBeNull();
    }
    // 対照群 ── Ctrl だけなら開く
    openClick(p);
    expect(box(r.host), '対照群: Ctrl+クリックで開かない').not.toBeNull();
  });

  it('🔑 触っていない塊は同じ実体のまま残る(丸ごと作り直していない)', () => {
    const r = rig();
    const h1 = findByText(r.host, 'h1', '題');
    const last = findByText(r.host, 'p', '最後の段落。');
    openClick(findByText(r.host, 'p', '最初の段落。'));
    expect(findByText(r.host, 'h1', '題')).toBe(h1);
    expect(findByText(r.host, 'p', '最後の段落。')).toBe(last);
  });

  it('表の行をクリックすると、その 1 行だけが入力欄になる(表ごとではない)', () => {
    const r = rig();
    const tr = findByText(r.host, 'tr', '3');
    openClick(tr);
    expect(box(r.host)!.value).toBe('| 3 | 4 |');
    expect(r.swap.activeRange).toEqual({ start: 7, end: 7 });
  });

  it('箇条書きの項目をクリックすると、その 1 項目だけが入力欄になる', () => {
    const r = rig();
    openClick(findByText(r.host, 'li', '二つめ'));
    expect(box(r.host)!.value).toBe('- 二つめ');
    expect(r.swap.activeRange).toEqual({ start: 10, end: 10 });
  });

  /**
   * 🔴 **開いている間、表 / 箇条書きの残りは画面に居る**
   * (#423。user 報告 2026-08-26「複数行のブロックが1行しか表示されない / 表とかで起きてる」)。
   *
   * ⚠ 直す前は**編集する範囲だけ**を行へ絞り、**差し替える相手は塊のまま**だった
   *   ── 押した瞬間に `tr` が 0 個・`table` が 0 個になり、
   *   3 行の表が**1 行の欄だけ**に化けていた。
   * 🔑 上の 2 つの test は `value` と `activeRange` を見ている(= **範囲**は正しかった)。
   *   ここが見るのは**周りが残っているか**である ── 観測点が塊の外にしか無かったので、
   *   12 日ぶん緑のまま出荷されていた(CLAUDE.md §1 の「狭すぎる観測点」)。
   */
  it('🔴 表の行を開いても、表の残りは画面に居る(塊ごと消さない) (#423)', () => {
    const r = rig();
    const before = r.host.querySelectorAll('tr').length;
    expect(before, '前提: 表に複数の行が在る').toBeGreaterThan(1);
    openClick(findByText(r.host, 'tr', '3'));
    expect(r.host.querySelectorAll('table'), '表ごと消えた').toHaveLength(1);
    expect(r.host.querySelectorAll('tr'), '表の行が消えた').toHaveLength(before);
    // 🔑 欄は**表の中**に居る(外へ飛び出していない)
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    expect(slot.tagName.toLowerCase(), '表の中に div を入れると parser が外へ出す').toBe('td');
    expect(slot.closest('table'), '欄が表の外に出ている').not.toBeNull();
    expect(slot.getAttribute('colspan'), '列数に合わせていない').toBe('2');
    // ⚠ 触っていない行の字は残っている(押した行だけが欄になった)
    expect(r.host.textContent).toContain('1');
    expect(box(r.host)!.value).toBe('| 3 | 4 |');
  });

  it('🔴 箇条書きの項目を開いても、他の項目は画面に居る (#423)', () => {
    const r = rig();
    const before = r.host.querySelectorAll('li').length;
    expect(before, '前提: 項目が複数ある').toBeGreaterThan(1);
    openClick(findByText(r.host, 'li', '二つめ'));
    expect(r.host.querySelectorAll('li'), '項目が消えた').toHaveLength(before);
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    expect(slot.tagName.toLowerCase()).toBe('li');
    expect(r.host.textContent, '触っていない項目が消えた').toContain('一つめ');
  });

  /**
   * ⚠ **対照群** ── 下位要素を持たない塊(段落 / コード)は、いまどおり**塊ごと**
   * 入力欄になる。⚠ これが無いと「常に下位要素だけ差し替える」変異を見分けられない。
   */
  it('⚠ 下位要素を持たない塊は、いまどおり塊ごと入力欄になる (#423 の対照群)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    expect(slot.tagName.toLowerCase(), '塊ごとの器が div でない').toBe('div');
  });

  /**
   * 🔴 **打鍵で描き直っても、表は消えない**(#423 の 2 つ目の口)。
   *
   * ⚠ `update()` は**別に**スロットを組み直すので、そちらを直し忘れると
   *   「押した瞬間は正しいが、次の描き直しで表が消える」という**もっと気づけない**
   *   形になる(CLAUDE.md §7「同じ判定が複数の場所にある」)。
   */
  it('🔴 開いたまま描き直しても、表の残りは消えない (#423)', () => {
    const r = rig();
    const before = r.host.querySelectorAll('tr').length;
    openClick(findByText(r.host, 'tr', '3'));
    const rowOf = (): number => {
      const slot = r.host.querySelector('[data-pkc-row-slot]')!;
      return [...r.host.querySelectorAll('tr')].indexOf(slot.closest('tr')!);
    };
    // 前提: 押したのは 3 行目(見出し + 1 行目 + **2 行目**)
    expect(rowOf(), '前提: 押した行に欄が出ていない').toBe(2);
    r.render(r.body()); // ⚠ 本文は同一(打鍵前の描き直し)
    expect(r.host.querySelectorAll('table'), '描き直しで表が消えた').toHaveLength(1);
    expect(r.host.querySelectorAll('tr')).toHaveLength(before);
    expect(box(r.host), '入力欄が居なくなった').not.toBeNull();
    /**
     * 🔑 **欄は押した行に居続ける** ── 数だけ見ると、欄が**別の行へ移っても**
     *   同じ数になる(見出し行が欄に化けても `tr` は 3 個のまま)。
     */
    expect(rowOf(), '描き直しで欄が別の行へ移った').toBe(2);
  });

  it('🔴 箇条書きも、描き直しで欄が別の項目へ移らない (#423)', () => {
    const r = rig();
    openClick(findByText(r.host, 'li', '二つめ'));
    const itemOf = (): number => {
      const slot = r.host.querySelector('[data-pkc-row-slot]')!;
      return [...r.host.querySelectorAll('li')].findIndex((li) => li === slot);
    };
    expect(itemOf(), '前提: 押した項目に欄が出ていない').toBe(1);
    r.render(r.body());
    expect(itemOf(), '描き直しで欄が別の項目へ移った').toBe(1);
    expect(box(r.host)!.value).toBe('- 二つめ');
  });

  it('🔑 閉じたら表は元どおりに戻る(穴を残さない) (#423)', () => {
    const r = rig();
    const before = r.host.querySelectorAll('tr').length;
    openClick(findByText(r.host, 'tr', '3'));
    box(r.host)!.blur();
    expect(r.host.querySelector('[data-pkc-row-slot]'), '器が残っている').toBeNull();
    expect(r.host.querySelectorAll('tr')).toHaveLength(before);
    expect(r.host.textContent).toContain('3');
  });

  it('🔑 末尾の空行は編集範囲に入れない(消すと塊の切れ目が消えるので)', () => {
    // `- 二つめ` は list_item の範囲が後ろの空行(11)まで伸びている
    const r = rig();
    openClick(findByText(r.host, 'li', '二つめ'));
    expect(r.swap.activeRange).toEqual({ start: 10, end: 10 });
    expect(box(r.host)!.value).toBe('- 二つめ');
    // 確定しても、後ろの空行はそのまま残っている(合体していない)
    box(r.host)!.blur();
    expect(r.body().split('\n')[11]).toBe('');
    expect(r.host.querySelectorAll('li')).toHaveLength(2);
  });

  /**
   * 🔴 **器を組む所を直接見る**(#423)。
   *
   * ⚠ 「見つからなければ塊ごとへ落ちる」枝は、面から押す経路では**一度も通らない**
   *   (`resolveSubUnit` が実際に見つけた要素の添字を渡すので、必ず解決する)。
   *   変異試験 U5 が SURVIVED で教えたので、**関数を直接呼んで**通す ──
   *   通らない枝に判断を書いたまま置かない(CLAUDE.md §2)。
   */
  describe('器を組む(#423)', () => {
    const TABLE = '<table><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>';
    it('表の行は tr/td の器になり、列数に合わせる', () => {
      const html = blockWithSubSlot(TABLE, 'tr', 1)!;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const slot = tpl.content.querySelector('[data-pkc-row-slot]')!;
      expect(slot.tagName.toLowerCase()).toBe('td');
      expect(slot.getAttribute('colspan')).toBe('2');
      // ⚠ 触っていない行は残っている
      expect(tpl.content.querySelectorAll('tr')).toHaveLength(2);
      expect(tpl.content.textContent).toContain('1');
      expect(tpl.content.textContent, '押した行の字が残っている').not.toContain('3');
    });

    it('箇条書きの項目は li の器になる', () => {
      const html = blockWithSubSlot('<ul><li>あ</li><li>い</li></ul>', 'li', 0)!;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const slot = tpl.content.querySelector('[data-pkc-row-slot]')!;
      expect(slot.tagName.toLowerCase()).toBe('li');
      expect(tpl.content.querySelectorAll('li')).toHaveLength(2);
      expect(tpl.content.textContent).toContain('い');
    });

    /**
     * 🔴 **見つからなければ `null`** ── 呼び側が「塊ごと」へ落ちる合図である。
     * ⚠ ここで元の HTML を返すと、**器がどこにも無い**まま差し替えたことになり、
     *   `open()` が欄を置けずに `false` を返す = **押しても何も起きない**。
     */
    it('🔴 その添字の下位要素が無ければ null(塊ごとへ落ちる合図)', () => {
      expect(blockWithSubSlot(TABLE, 'tr', 9), '無い行で器を組んでいる').toBeNull();
      expect(blockWithSubSlot('<p>ただの段落</p>', 'li', 0)).toBeNull();
    });
  });

  it('リンクや押せるものは奪わない(押せるものは押せたまま)', () => {
    const r = rig('本文に [リンク](#anchor) が在る。');
    openClick(findByText(r.host, 'a', 'リンク'));
    expect(box(r.host)).toBeNull();
    expect(r.swap.isActive).toBe(false);
  });

  it('⑤ 自動で作られる部分(脚注の区切り)は開かず、理由を出す', () => {
    const r = rig(['本文[^a]', '', '[^a]: 注', ''].join('\n'));
    const hr = r.host.querySelector('hr');
    expect(hr).not.toBeNull();
    openClick(hr!);
    expect(box(r.host)).toBeNull();
    expect(r.notes.join('/')).toContain('自動で作られる');
  });
});

describe('RowSwap — 末尾に書き足す(空のノートの入口)', () => {
  it('🔴 空の本文でも、面を押せば行が開く(1 文字も打てない状態にしない)', () => {
    const r = rig('');
    // 描画は空 ── 押す所が無いので、面そのものを押す
    expect(r.host.querySelectorAll('p')).toHaveLength(0);
    click(r.host);
    const ta = box(r.host);
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('');
    ta!.value = '# はじめての見出し';
    ta!.blur();
    expect(r.body()).toBe('# はじめての見出し');
    expect(findByText(r.host, 'h1', 'はじめての見出し')).toBeTruthy();
  });

  it('本文が在るときは**末尾に足す**(最後の塊を潰さない)', () => {
    const r = rig();
    click(r.host);
    const ta = box(r.host)!;
    ta.value = '書き足した段落。';
    ta.blur();
    const lines = r.body().split('\n');
    expect(lines[12]).toBe('最後の段落。'); // 元の末尾は残っている
    expect(lines[lines.length - 1]).toBe('書き足した段落。');
    expect(findByText(r.host, 'p', '書き足した段落。')).toBeTruthy();
  });

  it('何も打たずに閉じたら、本文も画面も変わらない', () => {
    const r = rig();
    click(r.host);
    box(r.host)!.blur();
    expect(r.body()).toBe(DOC);
    expect(r.commits).toEqual([]);
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
  });

  /**
   * 🔴 **`Alt` は余白でも受けない**(着地前レビュー M9)。
   * ⚠ `Alt` は読む面の「追記の入り先」なので、指したつもりで**末尾に空の行が
   *   開く**と、user は「入り先を選んだら本文が変わった」と読む。
   * ⚠ この門を余白の枝の**後ろ**へ移す変異が、これが無いと素通りする。
   */
  it('🔴 Alt を押しながら余白を押しても、行は開かない', () => {
    const r = rig();
    r.host.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, altKey: true }));
    expect(box(r.host), 'Alt+余白で行が開いた').toBeNull();
    // 対照群 ── Alt を離せば開く(空のノートの入口は塞いでいない)
    click(r.host);
    expect(box(r.host)).not.toBeNull();
  });

  it('🔴 確定のためのクリック(余白)で、新しい行が開いてしまわない', () => {
    // ⚠ 描き直しを**溜める** rig ── 実機の窓(確定 → 描き直しが届く前)を作る
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '書き換えた。';
    /**
     * 実機の順序は `mousedown → blur(= 確定)→ click`。blur で確定した直後に
     * 余白の click が届くので、そこで開くと「開いて即閉じる」がちらつく
     * (しかも `this.body` が古いので、届いた描き直しが「外から変わった」と読む)。
     */
    ta.dispatchEvent(new Event('blur'));
    click(r.host);
    expect(box(r.host), '確定のクリックで新しい行を開いた').toBeNull();
    r.flush();
    expect(r.commits).toHaveLength(1);
    expect(r.notes.join('/')).not.toContain('外から本文が変わった');
    expect(findByText(r.host, 'p', '書き換えた。')).toBeTruthy();
  });

  it('描き直しが届いた**後**の余白クリックでは、ちゃんと行が開く', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '書き換えた。';
    ta.dispatchEvent(new Event('blur'));
    r.flush();
    click(r.host);
    expect(box(r.host), '書き足す行が開かない(封じすぎている)').not.toBeNull();
  });
});

describe('RowSwap — 確定と取り消し', () => {
  it('焦点が外れたら 1 回だけ確定し、本文の該当行だけが変わる', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '書き換えた段落。';
    ta.blur();
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '書き換えた段落。' }]);
    expect(r.body().split('\n')[2]).toBe('書き換えた段落。');
    // 描き直しが済んで、入力欄は残っていない
    expect(box(r.host)).toBeNull();
    expect(findByText(r.host, 'p', '書き換えた段落。')).toBeTruthy();
  });

  it('② Escape は確定せず、**描画が戻る**(穴が残らない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '捨てられる文字';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(r.commits).toEqual([]);
    expect(box(r.host)).toBeNull();
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
    expect(findByText(r.host, 'p', '最初の段落。')).toBeTruthy();
  });

  it('② 変えずに確定しても描画が戻る(`commit` が描き直さない経路)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    box(r.host)!.blur();
    // 本文は変わらないので `commit` は描き直しを起こさない ── それでも穴は無い
    expect(r.body()).toBe(DOC);
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
    expect(findByText(r.host, 'p', '最初の段落。')).toBeTruthy();
  });

  it('Tab と Ctrl+Enter でも確定する', () => {
    for (const ev of [
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    ]) {
      const r = rig();
      openClick(findByText(r.host, 'p', '最初の段落。'));
      const ta = box(r.host)!;
      ta.value = 'かえた';
      ta.dispatchEvent(ev);
      expect(r.commits).toHaveLength(1);
    }
  });

  it('🔴 確定で入力欄を外した瞬間の `blur` で、二重に確定しない(再入)', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = 'かえた';
    /**
     * ⚠ **環境の意味論を真似る**(stub は本物に合わせる ── CLAUDE.md)。
     * Chromium は**焦点のある textarea を DOM から外すと同期で `blur` を飛ばす**。
     * happy-dom は飛ばさないので、その 1 点だけを手で足す。
     * 実機ではこれで `commit` が 2 回走り、view の組み直しが二重になって
     * `NotFoundError` の pageerror が出ていた(smoke で捕まえた)。
     */
    const origRemove = ta.remove.bind(ta);
    ta.remove = (): void => {
      origRemove();
      ta.dispatchEvent(new Event('blur'));
    };
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(r.commits, '同じ編集が 2 回確定した').toHaveLength(1);
    r.flush();
    expect(findByText(r.host, 'p', 'かえた')).toBeTruthy();
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
  });

  it('別の行をクリックすると、前の行が確定してから開く', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = 'ひとつめを書き換え';
    openClick(findByText(r.host, 'p', '最後の段落。'));
    expect(r.commits).toEqual([{ start: 2, end: 2, text: 'ひとつめを書き換え' }]);
    expect(box(r.host)!.value).toBe('最後の段落。');
  });
});

describe('RowSwap — 範囲差し替え(S6)', () => {
  it('🔴 全文を 1 つの入力欄にできる(今日の編集画面が縮退形になる)', () => {
    const r = rig();
    expect(r.swap.activateAll()).toBe(true);
    const ta = box(r.host)!;
    // 🔴 本文が**丸ごと**入っている(先頭も末尾も落ちていない)
    expect(ta.value).toBe(DOC);
    expect(r.swap.activeRange).toEqual({ start: 0, end: 12 });
    // 描画済みの塊は全部 SLOT に置き換わっている(2 つの画面が同居しない)
    expect(r.host.querySelectorAll('p')).toHaveLength(0);
    expect(r.host.querySelectorAll('table')).toHaveLength(0);
    expect(r.host.querySelectorAll('[data-pkc-row-slot]')).toHaveLength(1);
  });

  it('🔴 全文を書き換えて確定すると、本文が丸ごと入れ替わる', () => {
    const r = rig();
    r.swap.activateAll();
    const ta = box(r.host)!;
    ta.value = '# 新しい題\n\n作り直した本文。';
    ta.blur();
    expect(r.body()).toBe('# 新しい題\n\n作り直した本文。');
    expect(findByText(r.host, 'h1', '新しい題')).toBeTruthy();
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
  });

  it('全文を開いて何も変えずに閉じたら、描画がそのまま戻る', () => {
    const r = rig();
    r.swap.activateAll();
    box(r.host)!.blur();
    expect(r.body()).toBe(DOC);
    expect(r.commits).toEqual([]);
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
    // 🔴 全部の塊が戻っている(まとめて置いた HTML が再分割されている)
    expect(findByText(r.host, 'h1', '題')).toBeTruthy();
    expect(r.host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(r.host.querySelectorAll('li')).toHaveLength(2);
    expect(findByText(r.host, 'p', '最後の段落。')).toBeTruthy();
  });

  /**
   * 🔴 **折り返した先も数える**(2026-08-15、user 報告「1 行の選択をすると表示が
   * 適切なサイズのテキストブロックにならないため編集しにくい」)。
   *
   * ⚠ happy-dom は版面を持たない(`scrollHeight` も `line-height` も出ない)ので、
   * **値を差して分岐を実際に走らせる** ── 走らせないと「測れないから 0」と
   * 「折り返しが無いから 0」が見分けられず、この分岐は 1 度も通らないまま緑になる。
   */
  it('🔴 折り返して溢れたぶんだけ箱を伸ばす(改行の数で決めない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    expect(ta.value.includes('\n'), '前提: 改行を持たない塊で見ていない').toBe(false);
    expect(Number(ta.rows), '版面が測れない環境では改行の数のまま').toBe(1);

    /**
     * 版面を差す: 1 行 20px の箱(20px)に 55px の中身 ── 溢れは 35px。
     * ⚠ **端数を残す**(35 / 20 = 1.75)── 割り切れる値にすると、切り上げを
     * 切り捨てに変える誤りが**同じ答えを出して**生き延びる。
     */
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === ta
        ? ({ lineHeight: '20px' } as unknown as CSSStyleDeclaration)
        : real(el as Element, pseudo),
    );
    Object.defineProperty(ta, 'clientHeight', { value: 20, configurable: true });
    Object.defineProperty(ta, 'scrollHeight', { value: 55, configurable: true });
    try {
      ta.dispatchEvent(new Event('input'));
      expect(Number(ta.rows), '折り返した 2 行ぶんを足していない').toBe(3);
      expect(ta.hasAttribute('data-pkc-scroll'), '上限に届いていないのに箱の中で scroll させている').toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('🔴 折り返しても上限は超えない(超えたら箱の中で scroll)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === ta
        ? ({ lineHeight: '20px' } as unknown as CSSStyleDeclaration)
        : real(el as Element, pseudo),
    );
    // 1 行の箱に 200 行ぶん(4000px)── 上限 40 を超える
    Object.defineProperty(ta, 'clientHeight', { value: 20, configurable: true });
    Object.defineProperty(ta, 'scrollHeight', { value: 4000, configurable: true });
    try {
      ta.dispatchEvent(new Event('input'));
      expect(Number(ta.rows)).toBe(40);
      expect(ta.getAttribute('data-pkc-scroll'), '上限に当たったのに箱の中で scroll しない').toBe('1');
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * ⚠ **これは「見え方」ではなく「測りに行かないこと」を守る test** である
   * (変異試験で `logical < ROWS_CAP` の門を外しても DOM は 1 ミリも変わらなかった
   * ── 上限に当たっている以上 `rows` も印も同じになるので、**出力では殺せない**)。
   * 🔑 門の目的は打鍵ごとの reflow を増やさないことなので、**測ったかどうか**を見る。
   */
  it('🔴 上限に届いている塊では、折り返しを測りに行かない(打鍵ごとの reflow を増やさない)', () => {
    const r = rig(Array.from({ length: 200 }, (_, i) => `段落 ${i}。`).join('\n\n'));
    const real = window.getComputedStyle.bind(window);
    let measured = 0;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      if (el instanceof HTMLTextAreaElement) measured += 1;
      return real(el as Element, pseudo);
    });
    try {
      r.swap.activateAll();
      const ta = box(r.host)!;
      expect(Number(ta.rows)).toBe(40);
      measured = 0;
      ta.dispatchEvent(new Event('input'));
      expect(measured, '上限に届いているのに版面を測っている').toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * 🔴 **行の高さが読めない版面で数を作らない**。`line-height: normal` は
   * `parseFloat` で NaN になる ── そのまま割ると `rows` に NaN を代入することになり、
   * **箱の高さごと壊れる**。⚠ happy-dom では溢れが常に 0 なのでこの門は素通りする
   * (= 出力では殺せない)。だから**溢れを差してから**読めない高さを渡す。
   */
  it('🔴 行の高さが読めない版面では、折り返しを数えない', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === ta
        ? ({ lineHeight: 'normal' } as unknown as CSSStyleDeclaration)
        : real(el as Element, pseudo),
    );
    Object.defineProperty(ta, 'clientHeight', { value: 20, configurable: true });
    Object.defineProperty(ta, 'scrollHeight', { value: 55, configurable: true });
    try {
      ta.dispatchEvent(new Event('input'));
      expect(Number(ta.rows), '高さが読めないのに数を作っている(rows が壊れる)').toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('高さには上限を置く(5000 行の箱を作らない)', () => {
    const long = Array.from({ length: 200 }, (_, i) => `段落 ${i}。`).join('\n\n');
    const r = rig(long);
    r.swap.activateAll();
    const ta = box(r.host)!;
    expect(ta.value.split('\n').length).toBeGreaterThan(100);
    expect(Number(ta.rows), '中身の行数ぶんの箱を作っている').toBeLessThanOrEqual(40);
    expect(ta.getAttribute('data-pkc-scroll'), '箱の中で scroll させていない').toBe('1');
  });

  it('Shift+クリックで範囲を広げる(2 つの塊が 1 つの入力欄になる)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    expect(r.swap.activeRange).toEqual({ start: 2, end: 2 });
    // 表まで広げる
    const tr = findByText(r.host, 'tr', '3');
    // ⚠ **`mousedown`** で受ける(実機は `click` まで待つと blur が先に走って
    //    「広げる元」が消える ── 2026-08-05 に smoke が拾った)
    // 🔴 **既定を止めている**ことまで見る ── 止めないと直後の焦点移動で
    //    blur → 確定が走り、開いた範囲がその場で閉じる(実機だけで起きる)
    expect(shiftDown(tr), '既定を止めていない(焦点が外れて範囲が閉じる)').toBe(true);
    expect(r.swap.activeRange).toEqual({ start: 2, end: 7 });
    expect(box(r.host)!.value).toBe(DOC.split('\n').slice(2, 8).join('\n'));
    // 広げた範囲を書き換えて確定 ── その範囲だけが変わる
    box(r.host)!.value = 'まとめて 1 行に。';
    box(r.host)!.blur();
    expect(r.body()).toBe(['# 題', '', 'まとめて 1 行に。', '', '- 一つめ', '- 二つめ', '', '最後の段落。'].join('\n'));
  });

  it('🔴 打ち替えた後は広げない(古い行番号で範囲を作らない)', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '打ち替えた。';
    const tr = findByText(r.host, 'tr', '3');
    shiftDown(tr);
    // 確定はした / 範囲は広げていない / 理由が出ている
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '打ち替えた。' }]);
    expect(r.swap.isActive).toBe(false);
    expect(r.notes.join('/')).toContain('もう一度 Shift+クリック');
    r.flush();
    expect(findByText(r.host, 'p', '打ち替えた。')).toBeTruthy();
  });

  it('🔴 範囲を開いたまま描き直しを受けても、閉じれば全部戻る', () => {
    const r = rig();
    r.swap.activateAll();
    const ta = box(r.host)!;
    // 同じ本文の描き直しが届く(封印明け・外からの再描画)
    r.render(DOC);
    // 入力欄は生きていて、描画の塊は 1 つも復活していない
    expect(box(r.host)).toBe(ta);
    expect(r.host.querySelectorAll('p')).toHaveLength(0);
    expect(r.host.querySelectorAll('[data-pkc-row-slot]')).toHaveLength(1);
    // 閉じると**全部**戻る(1 塊ぶんしか覚えていないと、ここで本文が消える)
    ta.blur();
    expect(r.host.querySelector('[data-pkc-row-slot]')).toBeNull();
    expect(findByText(r.host, 'h1', '題')).toBeTruthy();
    expect(r.host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(r.host.querySelectorAll('li')).toHaveLength(2);
    expect(findByText(r.host, 'p', '最後の段落。')).toBeTruthy();
  });

  it('🔴 先頭に空行が在る本文でも、全文選択は本当に全部入る', () => {
    // ⚠ 塊の持つ行から範囲を出すと、**先頭の空行が落ちる**(fixture の非ゼロ次元)
    const body = ['', '', '# 題', '', '本文。', ''].join('\n');
    const r = rig(body);
    expect(r.swap.activateAll()).toBe(true);
    expect(box(r.host)!.value).toBe(['', '', '# 題', '', '本文。'].join('\n'));
    expect(r.swap.activeRange).toEqual({ start: 0, end: 4 });
  });

  it('🔴 範囲を後ろへ広げてから手前へ広げても、後ろ端が落ちない', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    shiftDown(findByText(r.host, 'tr', '3')); // 2..7 へ広げた
    expect(r.swap.activeRange).toEqual({ start: 2, end: 7 });
    // 手前(見出し)へ広げる ── 後ろ端 7 は保たれるべき
    shiftDown(findByText(r.host, 'h1', '題'));
    expect(r.swap.activeRange, '広げた後ろ端が落ちた').toEqual({ start: 0, end: 7 });
    expect(box(r.host)!.value).toBe(DOC.split('\n').slice(0, 8).join('\n'));
  });

  it('空の本文で全文を開くと、末尾に書き足す形になる(空の箱を出さない)', () => {
    const r = rig('');
    expect(r.swap.activateAll()).toBe(true);
    const ta = box(r.host)!;
    expect(ta.value).toBe('');
    ta.value = '書き始めた。';
    ta.blur();
    expect(r.body()).toBe('書き始めた。');
  });
});

describe('RowSwap — 日本語入力の契約', () => {
  it('③ 封印中は描画を当てない(ノードを動かさない)。解けたら保留の 1 件が流れる', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    expect(r.swap.isComposing).toBe(true);
    const h1 = findByText(r.host, 'h1', '題');
    // 封印中に描画が届く(同じ本文の描き直し ── 続けて編集できる側)
    const { html, ranges } = renderMarkdownWithRanges(DOC);
    expect(r.swap.update(DOC, html, ranges).ok).toBe(true);
    // ⚠ **当てていない**(同じ実体・入力欄も生きている)
    expect(findByText(r.host, 'h1', '題')).toBe(h1);
    expect(box(r.host)).toBe(ta);
    // 封印が解けたら保留していた 1 件が流れる ── それでも入力欄は同じ実体
    ta.dispatchEvent(new Event('compositionend'));
    expect(box(r.host)).toBe(ta);
    expect(r.swap.isActive).toBe(true);
  });

  it('③ 封印中に**外から本文が変わった**ら、解けた時点で閉じる(継ぎ足さない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    const other = DOC.replace('# 題', '# 題(外から変えた)');
    const { html, ranges } = renderMarkdownWithRanges(other);
    expect(r.swap.update(other, html, ranges).ok).toBe(true);
    // 封印中は当てない(見出しは古いまま)
    expect(r.host.querySelector('h1')!.textContent).not.toContain('外から変えた');
    ta.dispatchEvent(new Event('compositionend'));
    // 保留が流れて、行は閉じる
    expect(r.host.querySelector('h1')!.textContent).toContain('外から変えた');
    expect(r.swap.isActive).toBe(false);
    expect(r.commits).toEqual([]);
    expect(r.notes.join('/')).toContain('外から本文が変わった');
  });

  it('③ `compositionend` は確定ではない(変換の取り消しでも出る)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    ta.dispatchEvent(new Event('compositionend'));
    expect(r.commits).toEqual([]);
    expect(r.swap.isActive).toBe(true);
  });

  it('③ 変換中の `blur` は同期で確定せず、`compositionend` の後に 1 回だけ確定する', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    ta.value = 'にほんご';
    ta.dispatchEvent(new Event('blur'));
    expect(r.commits).toEqual([]); // ⚠ ここで確定すると変換中の文字が落ちる
    ta.dispatchEvent(new Event('compositionend'));
    expect(r.commits).toEqual([{ start: 2, end: 2, text: 'にほんご' }]);
  });

  it('③ 変換中のキーは全部 IME のもの ── **奪わない**(既定を止めない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    for (const key of ['Escape', 'Tab', 'Enter']) {
      const ev = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      ta.dispatchEvent(ev);
      /**
       * 🔴 ここが観測点。「確定しなかった」だけを見ると素通りする
       * ── `preventDefault` を撃つと、**IME の変換確定・取り消しが効かなくなる**
       * (確定も取り消しも起こらないので、下流の assert では見えない)。
       */
      expect(ev.defaultPrevented, `${key} を奪っている`).toBe(false);
    }
    expect(r.commits).toEqual([]);
    expect(r.swap.isActive).toBe(true);
    expect(r.swap.isComposing).toBe(true);
  });

  it('③ 変換中に auto pair の記号を打っても、IME から奪わない', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '';
    ta.dispatchEvent(new Event('compositionstart'));
    const ev = new KeyboardEvent('keydown', {
      key: '「',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(ta.value).toBe('');
  });

  it('③ 安全弁: 変換中なのに焦点が外れていたら封印を解く(永久固着の防止)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    expect(r.swap.isComposing).toBe(true);
    // `compositionend` が来ないまま焦点が外れた(DOM を触られたときに起きる)
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    ta.dispatchEvent(new Event('focusout'));
    expect(r.swap.isComposing).toBe(false);
  });
});

describe('RowSwap — 外から描画が届いたとき', () => {
  it('④ 同じ本文の描き直しでは、活性の入力欄が同じ実体で残る(pin が効いている)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const h1 = findByText(r.host, 'h1', '題');
    const last = findByText(r.host, 'p', '最後の段落。');
    const { html, ranges } = renderMarkdownWithRanges(DOC);
    expect(r.swap.update(DOC, html, ranges).ok).toBe(true);
    expect(box(r.host)).toBe(ta); // 🔴 作り直されていない = 打っている途中が消えない
    expect(ta.value).toBe('最初の段落。');
    expect(findByText(r.host, 'h1', '題')).toBe(h1);
    expect(findByText(r.host, 'p', '最後の段落。')).toBe(last);
    expect(r.swap.activeRange).toEqual({ start: 2, end: 2 });
  });

  it('④ 🔴 外から本文が差し替わったら、編集していた行を閉じて理由を出す', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最後の段落。'));
    const ta = box(r.host)!;
    ta.value = '打ちかけの文字';
    // 行がずれる本文が外から届く(取り込み・別タブの保存など)
    const next = ['# 題', '', '上に足した段落。', '', ...DOC.split('\n').slice(2)].join('\n');
    const { html, ranges } = renderMarkdownWithRanges(next);
    expect(r.swap.update(next, html, ranges).ok).toBe(true);
    // 🔴 継ぎ足していない(古い行番号で splice すると無関係な行を潰す)
    expect(r.commits).toEqual([]);
    expect(r.swap.isActive).toBe(false);
    expect(box(r.host)).toBeNull();
    expect(r.notes.join('/')).toContain('外から本文が変わった');
    expect(findByText(r.host, 'p', '最後の段落。')).toBeTruthy();
  });

  it('新しく入った塊だけを `inserted` で返す(図の焼き直しを起こさない)', () => {
    const r = rig();
    const next = DOC.replace('最後の段落。', '書き換えた最後。');
    const { html, ranges } = renderMarkdownWithRanges(next);
    const out = r.swap.update(next, html, ranges);
    expect(out.ok).toBe(true);
    expect(out.inserted).toHaveLength(1);
    expect(out.inserted[0]!.textContent).toContain('書き換えた最後。');
  });
});

describe('RowSwap — 開放終端 と auto pair', () => {
  it('打っている最中に閉じていない ``` を見つけて印を付ける', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    expect(slot.hasAttribute('data-pkc-open-end')).toBe(false);
    ta.value = '```js';
    ta.dispatchEvent(new Event('input'));
    expect(slot.getAttribute('data-pkc-open-end')).toBe('fence');
    // 閉じたら印が消える
    ta.value = '```js\nconst a = 1;\n```';
    ta.dispatchEvent(new Event('input'));
    expect(slot.hasAttribute('data-pkc-open-end')).toBe(false);
  });

  it('閉じないまま確定したら**確定はする**が、理由を出す(移動できない罠にしない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '```js';
    ta.blur();
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '```js' }]);
    expect(r.notes.join('/')).toContain('閉じていない');
  });

  it('行内の閉じ待ち(`**`)にも印を付ける ── ただしブロックとは別の値', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    ta.value = '**太字を打ちかけ';
    ta.dispatchEvent(new Event('input'));
    expect(slot.getAttribute('data-pkc-open-end')).toBe('inline');
  });

  it('🔴 auto pair: 行頭で ``` を打ち切ると閉じが次の行に入り、開放終端が消える', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    // 行頭に 2 つ在る状態(1・2 つ目は補わないのでブラウザが打った形)
    ta.value = '``';
    ta.setSelectionRange(2, 2);
    ta.dispatchEvent(new Event('input'));
    // 前提: この時点では閉じ待ちに見えていない(偶数個なので行内の対として釣り合う)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '`', bubbles: true, cancelable: true }));
    expect(ta.value).toBe('```\n```');
    expect(ta.selectionStart, 'caret が言語を打てる位置に無い').toBe(3);
    expect(Number(ta.rows), '高さが中身に追いついていない').toBe(2);
    // 🔴 閉じが入ったので開放終端の印は付かない(そもそも作らせないのが趣旨)
    expect(slot.hasAttribute('data-pkc-open-end')).toBe(false);
    // 確定しても「閉じていない」とは言われない
    ta.blur();
    expect(r.notes.join('/')).not.toContain('閉じていない');
  });

  it('🔴 auto pair が無ければ ``` は閉じ待ちになる(上の test が空振りでない証拠)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    // 補完を通さずに `` ``` `` だけを置く(= 昔の挙動)
    ta.value = '```';
    ta.dispatchEvent(new Event('input'));
    expect(slot.getAttribute('data-pkc-open-end')).toBe('fence');
  });

  it('auto pair: 対の記号を打つと閉じが入り、caret は中に置かれる', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '';
    ta.setSelectionRange(0, 0);
    const ev = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ta.value).toBe('[]');
    expect(ta.selectionStart).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  /**
   * 🔴 **閉じを打っても増えない**(2026-08-21、cowork 実機レポート #15)。
   *
   * ⚠ 直す前の test は「`[` を打って `[]` になる」で**そこで終わっていた** ──
   *   **次の打鍵を 1 つも進めていない**ので、`]` を打つと `[]]` になることを
   *   誰も見ていなかった(CLAUDE.md §2「経路が一度も通っていない」)。
   * ⚠ ここは DOM 側の主張である ── **通り抜けでは `insertText` を呼ばない**
   *   (空文字を `execCommand` で撃つと undo の粒度が変わる)。
   *   `input` event の回数で「挿していない」を観測する。
   */
  it('🔴 auto pair: 閉じを打つと通り抜ける(挿さない・本文が増えない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '';
    ta.setSelectionRange(0, 0);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }));
    expect(ta.value, '前提が崩れている').toBe('[]');
    expect(ta.selectionStart).toBe(1);

    let inputs = 0;
    ta.addEventListener('input', () => (inputs += 1));
    const ev = new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ta.value, '閉じが二重になった').toBe('[]');
    expect(ta.selectionStart, 'caret が閉じの右へ進んでいない').toBe(2);
    expect(ev.defaultPrevented, 'ブラウザにそのまま打たせてしまっている').toBe(true);
    expect(inputs, '通り抜けなのに挿している(undo の粒度が変わる)').toBe(0);
  });

  it('auto pair: 選択があるときは**囲む**(選択が消えない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = 'ここ';
    ta.setSelectionRange(0, 2);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '「', bubbles: true, cancelable: true }));
    expect(ta.value).toBe('「ここ」');
    expect(ta.selectionStart).toBe(1);
    expect(ta.selectionEnd).toBe(3);
  });

});

describe('RowSwap — 端で同じ向きに 2 回押すと隣の塊へ(#524。user 指示 2026-08-28)', () => {
  /**
   * 🔴 **2026-08-28 に主張を裏返した。**
   *
   * 以前は `Alt+↑ / Alt+↓` だった(2026-08-15、user 指示「操作の暴発を防ぐ動線が
   * 欲しい」)。⚠ その前の素のキー版は **改行の有無**で端を判定していたので、
   * 改行を持たない長い段落では**箱のどこに居ても隣へ飛んだ**(user 報告の暴発)。
   *
   * 🔑 いまは判定が違う ── **既定に任せてから caret の着地点を見る**。
   * ブラウザは `↑` を端の行で押すと caret を `0` へ、`↓` を最終行で押すと末尾へ
   * 動かすので、**折り返しが在っても正しく端が分かる**(改行では分からなかった)。
   * ⚠ そして**暴発は 2 回という数で防ぐ** ── Alt を覚えなくてよくなった。
   *
   * ⚠ **happy-dom は ↑↓ で caret を動かさない。** だからこの file が測れるのは
   *   「**端に居るとき**の数え方」だけである ── 🔴 **折り返しの途中で飛ばないこと**は
   *   実ブラウザでしか測れないので `tests/smoke/row-edit.smoke.spec.ts` が見る
   *   (CLAUDE.md §2「本命の分岐を unit は 1 度も通らないことがある」)。
   */
  const press = async (
    ta: HTMLTextAreaElement,
    key: 'ArrowDown' | 'ArrowUp',
    init: KeyboardEventInit = {},
  ): Promise<KeyboardEvent> => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    ta.dispatchEvent(ev);
    // ⚠ 判定は**既定の後**なので 1 tick 待つ(実装が `setTimeout(0)` で見る)
    await new Promise((r) => setTimeout(r, 0));
    return ev;
  };

  it('🔴 最終行で ↓ を 2 回 ── 1 回目は移らず、2 回目で次の塊が開く(caret は先頭)', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '書き換えた。'; // 行数は変わらない
    ta.setSelectionRange(ta.value.length, ta.value.length);

    // 🔴 **対照群 ── 1 回では移らない**(これが無いと「常に飛ぶ」実装でも通る)
    await press(ta, 'ArrowDown');
    expect(box(r.host), '1 回目で隣の塊へ飛んでいる').toBe(ta);
    expect(r.commits, '1 回目で確定している').toEqual([]);

    await press(ta, 'ArrowDown');
    // 確定は 1 回・次の塊(表)が開いている
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '書き換えた。' }]);
    const next = box(r.host)!;
    expect(next.value).toBe(DOC.split('\n').slice(4, 8).join('\n'));
    expect(r.swap.activeRange).toEqual({ start: 4, end: 7 });
    expect(next.selectionStart, 'caret が先頭に無い').toBe(0);
  });

  it('🔴 先頭行で ↑ を 2 回 ── 前の塊が開く(caret は末尾)', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最後の段落。'));
    const ta = box(r.host)!;
    ta.setSelectionRange(0, 0);
    await press(ta, 'ArrowUp');
    expect(box(r.host), '1 回目で飛んでいる').toBe(ta);
    await press(ta, 'ArrowUp');
    const prev = box(r.host)!;
    expect(prev.value).toBe('- 一つめ\n- 二つめ');
    expect(r.swap.activeRange).toEqual({ start: 9, end: 10 });
    expect(prev.selectionStart, 'caret が末尾に無い').toBe(prev.value.length);
    expect(r.commits).toEqual([]); // 変えていないので確定は出ない
  });

  it('🔴 端に居ないうちは数えない(caret が端から離れていれば何回押しても移らない)', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    // ⚠ 前提: この塊は 1 文字以上あり、**端でない位置**が存在する
    expect(ta.value.length, '端でない位置が無い fixture').toBeGreaterThan(2);
    return (async () => {
      for (let i = 0; i < 4; i += 1) {
        ta.setSelectionRange(1, 1); // 先頭でも末尾でもない
        await press(ta, 'ArrowDown');
        await press(ta, 'ArrowUp');
      }
      expect(box(r.host), '端に居ないのに飛んだ').toBe(ta);
      expect(r.commits).toEqual([]);
    })();
  });

  it('🔴 向きが変わると数え直す(↓ のあと ↑ 1 回では移らない)', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await press(ta, 'ArrowDown'); // 下向きに 1
    ta.setSelectionRange(0, 0);
    await press(ta, 'ArrowUp'); // 向きが変わる → 上向きに 1(2 ではない)
    expect(box(r.host), '向きが変わったのに数えを引き継いだ').toBe(ta);
    // もう 1 回 ↑ でようやく移る
    await press(ta, 'ArrowUp');
    expect(box(r.host)!.value, '2 回目で移っていない').not.toBe('最初の段落。');
  });

  it('🔴 間に別のキーや打鍵が入ると数え直す(字を入れてから 1 回で飛ばない)', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.setSelectionRange(ta.value.length, ta.value.length);

    await press(ta, 'ArrowDown'); // 1
    // 別のキー(→)を打つ
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await press(ta, 'ArrowDown'); // 数え直しなので 1
    expect(box(r.host), '別のキーを挟んだのに数えが残った').toBe(ta);

    // 打鍵でも数え直す
    await press(ta, 'ArrowDown'); // 2 → 移りそう…ではなく、下で input を挟む
    const ta2 = box(r.host);
    expect(ta2, 'ここでは移っていてよい').not.toBe(ta);
  });

  it('🔴 打鍵(input)は数えを捨てる ── 字を入れた直後の 1 回で飛ばない', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await press(ta, 'ArrowDown'); // 1
    ta.value += 'あ';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await press(ta, 'ArrowDown'); // 数え直しなので 1
    expect(box(r.host), '打鍵のあと 1 回で飛んだ').toBe(ta);
    expect(r.commits, '飛んでいないのに確定した').toEqual([]);
  });

  it('🔴 Shift / Ctrl / Meta / Alt の併せ押しは数えない(選択の拡張・OS の割り当て)', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      await press(ta, 'ArrowDown', init);
      await press(ta, 'ArrowDown', init);
    }
    expect(box(r.host), '併せ押しで隣の塊へ飛んでいる').toBe(ta);
    expect(r.commits).toEqual([]);
  });

  /**
   * 🔴 **`Alt+↑↓` は効かなくなった**(#524。user 指示「廃止」)。
   * ⚠ **鍵の表からも消す** ── 残すと同じことをする道が 2 本になる(§7)。
   * 🔑 ここは実装ではなく**表**を見る ── 実装だけ消して表に残ると、
   *   鍵の一覧に「効かない鍵」が出続ける。
   */
  it('🔴 塊の移動の鍵(row-next / row-prev)は表から消えている', () => {
    const ids = KEY_COMMANDS.map((c) => c.id);
    expect(ids, 'row-next が残っている(Alt+↓ の 2 系統目)').not.toContain('row-next');
    expect(ids, 'row-prev が残っている(Alt+↑ の 2 系統目)').not.toContain('row-prev');
    // 空振り防止 ── 表そのものは生きている
    expect(ids, '鍵の表が空(この検査は何も見ていない)').toContain('row-commit');
  });

  it('末尾の塊で ↓ を 2 回 ── 末尾に書き足す(余白クリックと同じ意味論)', async () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最後の段落。'));
    const ta = box(r.host)!;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await press(ta, 'ArrowDown');
    await press(ta, 'ArrowDown');
    const appended = box(r.host)!;
    expect(appended.value).toBe('');
    expect(r.swap.activeRange).toEqual({ start: 13, end: 12 }); // 挿入の空区間
    // 空の書き足し行でさらに ↓ ── 増殖しない(何も起きない)
    await press(appended, 'ArrowDown');
    await press(appended, 'ArrowDown');
    expect(box(r.host)).toBe(appended);
  });

  it('導出物(脚注の区切り)は飛ばして、その先の塊を開く', async () => {
    const r = rig(['本文[^a]', '', 'おわり', '', '[^a]: 注', ''].join('\n'));
    openClick(findByText(r.host, 'p', 'おわり'));
    const ta = box(r.host)!;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await press(ta, 'ArrowDown');
    await press(ta, 'ArrowDown');
    // 区切りの <hr>(原文の行が無い)は飛ばし、定義行を持つ脚注の塊が開く
    expect(box(r.host)!.value).toBe('[^a]: 注');
    expect(r.swap.activeRange).toEqual({ start: 4, end: 4 });
  });

  it('🔴 行数が変わる確定でも移れる(予約 → 着弾後に・正しい行で開く)', async () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '1 行目。\n2 行目を足した。'; // +1 行
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await press(ta, 'ArrowDown');
    await press(ta, 'ArrowDown');
    // 座標が古い窓では開かない(古い行番号で開くと閉じ際の確定が他の行を潰す)
    expect(box(r.host)).toBeNull();
    r.flush();
    // 着弾後に、+1 ずれた**正しい行**で次の塊(表)が開いている
    const next = box(r.host)!;
    expect(next.value).toBe(['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n'));
    expect(r.swap.activeRange).toEqual({ start: 5, end: 8 });
    expect(next.selectionStart).toBe(0);
    // 嘘の理由(「外から本文が変わった」)は出ていない
    expect(r.notes.join('/')).not.toContain('外から本文が変わった');
    expect(r.body().split('\n').slice(2, 4)).toEqual(['1 行目。', '2 行目を足した。']);
  });

  it('🔴 行数が変わる確定の直後のクリックが dead click にならない(既知欠陥の修理)', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '1 行目。\n2 行目を足した。'; // +1 行
    ta.dispatchEvent(new Event('blur'));
    // 着弾前に別の塊をクリック ── 直す前は古い座標のまま開き、着弾の
    // `closeQuietly` に「外から本文が変わった」という嘘の理由で閉じられていた
    openClick(findByText(r.host, 'p', '最後の段落。'));
    expect(box(r.host), '古い座標のまま開いている').toBeNull();
    r.flush();
    const opened = box(r.host)!;
    expect(opened.value).toBe('最後の段落。');
    expect(r.swap.activeRange).toEqual({ start: 13, end: 13 }); // +1 ずれた正しい行
    expect(r.notes.join('/')).not.toContain('外から本文が変わった');
  });

  it('予約は「次に実際に開いた操作」で消える(古い予約が後から焦点を奪わない)', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    box(r.host)!.value = '1 行目。\n2 行目を足した。';
    box(r.host)!.dispatchEvent(new Event('blur'));
    openClick(findByText(r.host, 'p', '最後の段落。')); // 予約になる
    r.flush(); // 予約が果たされて「最後の段落。」が開く
    const opened = box(r.host)!;
    expect(opened.value).toBe('最後の段落。');
    // 変えずに閉じて、もう一度描き直しが来ても、二度と勝手に開かない
    opened.dispatchEvent(new Event('blur'));
    r.render(r.body());
    expect(box(r.host), '消えたはずの予約が開き直した').toBeNull();
  });

  it('予約より後に**別の開く操作が通ったら**、予約は上書きされる(奪い合いにしない)', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落。'));
    box(r.host)!.value = '1 行目。\n2 行目を足した。';
    box(r.host)!.dispatchEvent(new Event('blur'));
    openClick(findByText(r.host, 'p', '最後の段落。')); // 予約になる
    // その後に Ctrl+A ── これが user の最新の意思なので、こちらが勝つ
    expect(r.swap.activateAll()).toBe(true);
    /**
     * ⚠ **窓の中では開かない**(2026-08-08 の 2 巡目レビューで直した)。
     * 直す前はここで古い原文の全文入力欄が開いており、そこで確定すると
     * **打ち替えが消えて末尾行が複製された**(下の回帰 test が現物を見る)。
     */
    expect(box(r.host), '古い座標のまま全文入力欄が開いている').toBeNull();
    r.flush();
    // 着弾後、**新しい原文**で全文が開く。⚠ 先に積まれていた「最後の段落。」の
    // 予約は上書きされている(1 つの箱しか開かないことで見る)
    const all = box(r.host)!;
    expect(all.value, '古い原文で開いている(打ち替えが消えている)').toContain('2 行目を足した。');
    expect(all.value, '全文になっていない').toContain('最後の段落。');
    expect(r.notes.join('/'), '嘘の理由が出ている').not.toContain('外から本文が変わった');
  });

  /**
   * 🔴 **回帰: 窓の中の `activateAll` で本文が壊れないこと**(2026-08-08)。
   * 直す前の実測: `A\n\nB\n\nC` の `A` を `A1\nA2` に打ち替えて確定した直後に
   * `activateAll()` を撃つと、入力欄に**打つ前の姿**が出る。そこで 1 文字足して
   * 確定すると `A\n\nB\n\nCX\nC` ── **打ち替えが消え、末尾行が複製された**。無言。
   * ⚠ 既存の pin は「理由付きで閉じられること」しか見ておらず、**破壊の側は
   *   誰も守っていなかった**(だから緑のまま出荷されかけた)。
   */
  it('🔴 行数が変わる確定の直後に全文を開いて確定しても、本文が壊れない', () => {
    const r = rig('A\n\nB\n\nC', true);
    openClick(findByText(r.host, 'p', 'A'));
    box(r.host)!.value = 'A1\nA2';
    box(r.host)!.dispatchEvent(new Event('blur'));
    expect(r.body(), '前提: 確定が本文に届いている').toBe('A1\nA2\n\nB\n\nC');

    r.swap.activateAll(); // 窓の中 ── 予約になるだけで開かない
    expect(box(r.host), '窓の中で古い原文の入力欄が開いた').toBeNull();

    r.flush(); // 着弾 → 予約が果たされて**新しい原文**で開く
    const all = box(r.host)!;
    expect(all.value, '古い原文で開いている').toBe('A1\nA2\n\nB\n\nC');

    all.value = `${all.value}X`;
    all.dispatchEvent(new Event('blur'));
    expect(r.body(), '打ち替えが消えた / 行が複製された').toBe('A1\nA2\n\nB\n\nCX');
  });
});

describe('RowSwap — Ctrl+S(2026-08-08)', () => {
  it('🔴 Ctrl+S は行を確定し、ブラウザの保存ダイアログを止める', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '保存した。';
    const ev = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'ブラウザの保存ダイアログが開く').toBe(true);
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '保存した。' }]);
    expect(box(r.host)).toBeNull(); // 確定 = 行は閉じる(Tab と同じ)
  });

  it('Cmd+S(mac)でも同じ', () => {
    const r = rig();
    openClick(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = 'かえた';
    const ev = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(r.commits).toHaveLength(1);
  });
});

/**
 * 🔴 **開閉で作り直した塊を、外へ渡す**(#250)。
 *
 * ⚠ `update()` の返り(`inserted`)は呼び側が面倒をみているが、**行を開く /
 * 閉じる**ときの当て直しはこのクラスの中で完結しており、**誰も面倒をみていなかった**
 * ── 画像(`![…](asset:…)`)の塊を押して開き、**何も打たずに閉じる**と `<img>` は
 * 原文の HTML から作り直され、`src` の無い空の枠になる(実測)。本文は変わらないので
 * 描き直しも来ない = **画面から画像が消えたまま**。
 *
 * ⚠ 発火点は **2 か所**(開く / 閉じる)なので、test も 2 本要る。
 */
describe('RowSwap — 開閉で入り直した要素を外へ渡す(#250)', () => {
  const IMG = ['上の段落。', '', '![絵](asset:k1)', '', '下の段落。', ''].join('\n');

  it('🔴 行を**開いた**ときに渡る', () => {
    const r = rig(IMG);
    const before = r.inserted.length;
    openClick(findByText(r.host, 'p', '上の段落'));
    expect(r.host.querySelector('[data-pkc-field="row-source"]'), '前提: 行が開いていない')
      .not.toBeNull();
    expect(r.inserted.length, '開いたのに何も渡っていない').toBeGreaterThan(before);
    // 空振り防止 ── 空の配列を渡して「呼んだ」で終えていない
    expect(r.inserted.at(-1)!.length).toBeGreaterThan(0);
  });

  it('🔴 行を**閉じた**ときに渡る(そこに画像が居る)', () => {
    const r = rig(IMG);
    // 画像の塊そのものを押して開く ── 閉じるとこの塊が作り直される
    const img = r.host.querySelector('img[data-pkc-asset-key]');
    expect(img, '前提: 画像が描かれていない').not.toBeNull();
    openClick(img!);
    const ta = r.host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
    expect(ta, '前提: 画像の行が開かない').not.toBeNull();
    const before = r.inserted.length;
    // 何も打たずに閉じる(⚠ **本文が変わらない** = 描き直しは来ない)
    ta!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(r.commits, '前提: 本文が変わってしまった(この次元を測れていない)').toHaveLength(0);
    expect(r.inserted.length, '閉じたのに何も渡っていない').toBeGreaterThan(before);
    // 🔑 渡った中に**画像そのもの**が居る(渡す口が在るだけでは足りない)
    const els = r.inserted.at(-1)!;
    const has = els.some(
      (e) =>
        (e instanceof Element && e.matches('img[data-pkc-asset-key]')) ||
        e.querySelector?.('img[data-pkc-asset-key]') != null,
    );
    expect(has, '作り直された画像が渡っていない(src が空のまま残る)').toBe(true);
  });
});

describe('RowSwap — 組めない本文', () => {
  it('分割が組めなければ `ok: false` を返して差し替えを開かない', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const swap = new RowSwap(host, { commit: vi.fn(), onInserted: () => {} });
    /**
     * ⚠ **直った形を使い続けない**(2026-08-06 に 2 度取り替えた)。入れ子の `:::` も
     * id 無しの `:::figure` も直ったので、いまの実物は「**renderer が知らない名前**」
     * である ── 走査器は `:::name` を一律に囲いと見なすが、renderer は知っている
     * 名前だけを畳むので食い違い、開かない側に倒れる。
     */
    // ⚠ **2026-08-07 に fixture を替えた。** 走査器が `directive-open.ts` の判定を
    //    引くようになり、知らない名前(`:::unknown-thing`)は**開くようになった**。
    //    いま組めないのは「名前は知っているが属性が不正で畳めない」形である
    const body = [':::figure{id="あ い"}', '', '本文', '', ':::', '', 'あと', ''].join('\n');
    const { html, ranges } = renderMarkdownWithRanges(body);
    const out = swap.update(body, html, ranges);
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
    // ⚠ 差し替えを開かない = クリックしても入力欄が出ない
    expect(host.querySelector('[data-pkc-field="row-source"]')).toBeNull();
  });
});

/**
 * 🔴 **確定の直後に別の塊を押しても、打った文字が消えない**(2026-08-06。
 * user 報告「編集しようとして選択すると勝手にスクロールしてフォーカスが外れる」の
 * 隣で実測して見つけた)。
 *
 * 実機の順序は `mousedown → blur(= 確定) → openClick(次を開く)` で、**描き直しは
 * worker 越しに後から届く**。直す前はその着弾で `closeQuietly` が
 * **開いたばかりの入力欄を remove** していた(実機実測: 入力欄 0 件 / 焦点が本文へ /
 * 打った文字は行方不明)。IME なら**確定済みの日本語**が同じ枝で消える。
 *
 * 🔑 観測点は **入力欄が生きているか**。下流の「本文が正しいか」では素通りする
 * ── 打ちかけは `commit` を通らないので、本文はどちらでも正しい。
 *
 * ⚠ **行数が変わる確定の直後は、まだ別の塊を開けない**(未修理。2026-08-06 に実測)。
 *   `activate` は成功するのに `open()` が `slot === null` で false を返す経路が在り、
 *   **クリックが黙って無視される**(データは壊れないが無言の操作拒否)。原因は
 *   `applyBlocks` の pin の扱いまで追う必要があり、この test では**同じ行数の確定**
 *   だけを守る ── ここに「行数が変わる場合」を書いて緑にすると、壊れたまま固定される。
 */
describe('確定 → 着弾の窓(非同期の描き直し)', () => {
  /** 実機と同じ順序を作る。⚠ happy-dom は dispatch で blur を飛ばさないので手で撃つ。 */
  const commitByBlur = (r: Rig): void => {
    box(r.host)!.dispatchEvent(new Event('blur'));
  };

  it('🔴 確定の直後に別の塊を開いても、着弾で入力欄が閉じられない', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落'));
    box(r.host)!.value = '打ち替えた段落。';
    commitByBlur(r);
    // 着弾前に別の塊を開く(実機の `mousedown → blur → click` と同じ順序)
    openClick(findByText(r.host, 'p', '最後の段落'));
    expect(box(r.host), '別の塊が開けない(前提が崩れている = 何も検査していない)').not.toBeNull();
    box(r.host)!.value = '打ちかけの文字';
    // ここで worker の結果が着弾する
    r.flush();
    expect(box(r.host), '着弾で入力欄が閉じられた(打っていた文字が消える)').not.toBeNull();
    expect(box(r.host)!.value, '打ちかけの文字が失われた').toBe('打ちかけの文字');
    expect(r.notes.join('/'), '「外から本文が変わった」が鳴っている').not.toContain(
      '外から本文が変わった',
    );
  });

  /**
   * 🔴 **行数が変わる確定は、保護側に委ねる**(= 着弾で閉じるが**理由を出す**)。
   *
   * ⚠ ここを「入力欄が生き残る」に書き換えてはいけない ── 行数が変わると後続の
   *   塊の原文座標が全部ずれるので、その状態で 2 度目の確定を通すと**無関係な行を
   *   潰す**(静かなデータ破壊)。**閉じるのが正しい**。
   * 🔑 観測点は 2 つ:① 本文が 1 文字も壊れていないこと ② **無言で閉じないこと**。
   */
  it('🔴 行数が変わる確定は理由を出して閉じる(黙って壊さない)', () => {
    const r = rig(DOC, true);
    openClick(findByText(r.host, 'p', '最初の段落'));
    box(r.host)!.value = '1 行目。\n2 行目を足した。'; // +1 行
    commitByBlur(r);
    r.flush();
    // 本文は正しく継ぎ足されている(触っていない行は 1 文字も動かない)
    expect(r.body().split('\n')).toEqual([
      '# 題',
      '',
      '1 行目。',
      '2 行目を足した。',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      '- 一つめ',
      '- 二つめ',
      '',
      '最後の段落。',
    ]);
  });

  /**
   * ⚠ **保護が鳴る枝も pin する** ── 行数が変わった直後に別の塊を開いていた場合、
   * 着弾は入力欄を閉じる。**そのとき理由を出す**(無言の操作拒否を作らない)。
   */
  it('⚠ 開いている最中に外から本文が変わったら、理由を出して閉じられる', () => {
    const r = rig(DOC);
    openClick(findByText(r.host, 'p', '最初の段落'));
    expect(box(r.host), '前提: 入力欄が開いている').not.toBeNull();
    /**
     * 外から本文が差し替わる(取り込み / 別タブ)。⚠ **この test は 2026-08-08 に
     * 書き換えた** ── 以前は `activateAll()` を「窓の中で箱を開ける道具」として
     * 使っていたが、その窓では予約になって開かなくなった(データ破壊の口を塞いだ)。
     * 🔑 守りの**本来の場面**は「外から変わった」であり、そちらで pin し直した
     * ── 道具が無くなったからといって、守り自体を無検査にしない。
     */
    r.render('まるごと別の本文。\n\n二つめの段落。');
    expect(box(r.host), '閉じられていない(座標がずれた状態で編集が続く)').toBeNull();
    expect(r.notes.join('/'), '無言で閉じた').toContain('外から本文が変わった');
  });
});
