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
import { RowSwap } from '../../src/adapter/ui/render/row-swap';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';

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

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
}

function box(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
}

describe('RowSwap — 行を原文の入力欄に差し替える', () => {
  it('段落をクリックすると、その塊だけが原文の入力欄になる', () => {
    const r = rig();
    const p = findByText(r.host, 'p', '最初の段落。');
    click(p);
    const ta = box(r.host);
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('最初の段落。');
    expect(r.swap.activeRange).toEqual({ start: 2, end: 2 });
    // ⚠ **他の塊は同じ実体のまま**(丸ごと作り直しなら別物になる)
    expect(findByText(r.host, 'h1', '題').isConnected).toBe(true);
  });

  it('🔑 触っていない塊は同じ実体のまま残る(丸ごと作り直していない)', () => {
    const r = rig();
    const h1 = findByText(r.host, 'h1', '題');
    const last = findByText(r.host, 'p', '最後の段落。');
    click(findByText(r.host, 'p', '最初の段落。'));
    expect(findByText(r.host, 'h1', '題')).toBe(h1);
    expect(findByText(r.host, 'p', '最後の段落。')).toBe(last);
  });

  it('表の行をクリックすると、その 1 行だけが入力欄になる(表ごとではない)', () => {
    const r = rig();
    const tr = findByText(r.host, 'tr', '3');
    click(tr);
    expect(box(r.host)!.value).toBe('| 3 | 4 |');
    expect(r.swap.activeRange).toEqual({ start: 7, end: 7 });
  });

  it('箇条書きの項目をクリックすると、その 1 項目だけが入力欄になる', () => {
    const r = rig();
    click(findByText(r.host, 'li', '二つめ'));
    expect(box(r.host)!.value).toBe('- 二つめ');
    expect(r.swap.activeRange).toEqual({ start: 10, end: 10 });
  });

  it('🔑 末尾の空行は編集範囲に入れない(消すと塊の切れ目が消えるので)', () => {
    // `- 二つめ` は list_item の範囲が後ろの空行(11)まで伸びている
    const r = rig();
    click(findByText(r.host, 'li', '二つめ'));
    expect(r.swap.activeRange).toEqual({ start: 10, end: 10 });
    expect(box(r.host)!.value).toBe('- 二つめ');
    // 確定しても、後ろの空行はそのまま残っている(合体していない)
    box(r.host)!.blur();
    expect(r.body().split('\n')[11]).toBe('');
    expect(r.host.querySelectorAll('li')).toHaveLength(2);
  });

  it('リンクや押せるものは奪わない(押せるものは押せたまま)', () => {
    const r = rig('本文に [リンク](#anchor) が在る。');
    click(findByText(r.host, 'a', 'リンク'));
    expect(box(r.host)).toBeNull();
    expect(r.swap.isActive).toBe(false);
  });

  it('⑤ 自動で作られる部分(脚注の区切り)は開かず、理由を出す', () => {
    const r = rig(['本文[^a]', '', '[^a]: 注', ''].join('\n'));
    const hr = r.host.querySelector('hr');
    expect(hr).not.toBeNull();
    click(hr!);
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

  it('🔴 確定のためのクリック(余白)で、新しい行が開いてしまわない', () => {
    // ⚠ 描き直しを**溜める** rig ── 実機の窓(確定 → 描き直しが届く前)を作る
    const r = rig(DOC, true);
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
      click(findByText(r.host, 'p', '最初の段落。'));
      const ta = box(r.host)!;
      ta.value = 'かえた';
      ta.dispatchEvent(ev);
      expect(r.commits).toHaveLength(1);
    }
  });

  it('🔴 確定で入力欄を外した瞬間の `blur` で、二重に確定しない(再入)', () => {
    const r = rig(DOC, true);
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = 'ひとつめを書き換え';
    click(findByText(r.host, 'p', '最後の段落。'));
    expect(r.commits).toEqual([{ start: 2, end: 2, text: 'ひとつめを書き換え' }]);
    expect(box(r.host)!.value).toBe('最後の段落。');
  });
});

describe('RowSwap — 日本語入力の契約', () => {
  it('③ 封印中は描画を当てない(ノードを動かさない)。解けたら保留の 1 件が流れる', () => {
    const r = rig();
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.dispatchEvent(new Event('compositionstart'));
    ta.dispatchEvent(new Event('compositionend'));
    expect(r.commits).toEqual([]);
    expect(r.swap.isActive).toBe(true);
  });

  it('③ 変換中の `blur` は同期で確定せず、`compositionend` の後に 1 回だけ確定する', () => {
    const r = rig();
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最後の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
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
    click(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '```js';
    ta.blur();
    expect(r.commits).toEqual([{ start: 2, end: 2, text: '```js' }]);
    expect(r.notes.join('/')).toContain('閉じていない');
  });

  it('行内の閉じ待ち(`**`)にも印を付ける ── ただしブロックとは別の値', () => {
    const r = rig();
    click(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    const slot = r.host.querySelector('[data-pkc-row-slot]')!;
    ta.value = '**太字を打ちかけ';
    ta.dispatchEvent(new Event('input'));
    expect(slot.getAttribute('data-pkc-open-end')).toBe('inline');
  });

  it('auto pair: 対の記号を打つと閉じが入り、caret は中に置かれる', () => {
    const r = rig();
    click(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = '';
    ta.setSelectionRange(0, 0);
    const ev = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ta.value).toBe('[]');
    expect(ta.selectionStart).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('auto pair: 選択があるときは**囲む**(選択が消えない)', () => {
    const r = rig();
    click(findByText(r.host, 'p', '最初の段落。'));
    const ta = box(r.host)!;
    ta.value = 'ここ';
    ta.setSelectionRange(0, 2);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '「', bubbles: true, cancelable: true }));
    expect(ta.value).toBe('「ここ」');
    expect(ta.selectionStart).toBe(1);
    expect(ta.selectionEnd).toBe(3);
  });

});

describe('RowSwap — 組めない本文', () => {
  it('分割が組めなければ `ok: false` を返して差し替えを開かない', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const swap = new RowSwap(host, { commit: vi.fn() });
    // 入れ子の `:::`(今日の描画が壊れている ── 設計 §7-9)
    const body = [':::section', '', ':::note', '', '中身', '', ':::', '', ':::', ''].join('\n');
    const { html, ranges } = renderMarkdownWithRanges(body);
    const out = swap.update(body, html, ranges);
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
    // ⚠ 差し替えを開かない = クリックしても入力欄が出ない
    expect(host.querySelector('[data-pkc-field="row-source"]')).toBeNull();
  });
});
