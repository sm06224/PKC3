/** @vitest-environment happy-dom */
/**
 * 🔴 **マニュアルの窓**(#645。user 要望 2026-08-31
 * 「**ヘルプの中からマニュアルをアプリとして出してください。ちっとも改善していません**」)。
 *
 * ここが守るのは 3 つ:
 * 1. **目次の行は、必ず本文の見出しへ着く**(押しても何も起きない行を出さない)
 * 2. **描けなくても白紙にしない**(素の原文を出す)── そのときは目次を出さない
 * 3. **開けなかったら `null`**(呼び側が理由を言える。無言で終えない)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fillManualWindow,
  openManualWindow,
  MANUAL_WINDOW_NAME,
  MANUAL_WINDOW_TITLE,
} from '../../src/adapter/platform/manual-window';
import { manualSections } from '../../src/features/help/manual-find';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { Dispatcher } from '../../src/adapter/state/dispatcher';

const TEXT = ['# あ', '本文 1', '## い', '本文 2', '#### う', '本文 3'].join('\n');
const HTML = '<h1>あ</h1><p>本文 1</p><h2>い</h2><p>本文 2</p><h4>う</h4><p>本文 3</p>';

function blankDoc(): Document {
  return document.implementation.createHTMLDocument('');
}

/** 窓の代わり。⚠ `closed` を動かせるようにする(閉じられた回を見る)。 */
function fakeWin(): Window & { closed: boolean } {
  const doc = blankDoc();
  return { document: doc, closed: false, close: () => {} } as unknown as Window & {
    closed: boolean;
  };
}

describe('マニュアルの窓 — 組み上がった中身', () => {
  it('🔴 目次の行は、すべて本文の見出しへ着く', () => {
    const doc = blankDoc();
    fillManualWindow(doc, {
      title: MANUAL_WINDOW_TITLE,
      version: 'PKC3 v9.9.9',
      html: HTML,
      text: TEXT,
      sections: manualSections(TEXT),
    });
    const rows = [
      ...doc.querySelectorAll<HTMLButtonElement>('[data-pkc-region="manual-window-toc"] button'),
    ];
    expect(rows.length, '目次が空(空振り)').toBe(3);
    for (const row of rows) {
      const id = row.getAttribute('data-pkc-target')!;
      expect(doc.getElementById(id), `目次「${row.textContent}」の飛び先が無い`).not.toBeNull();
    }
  });

  /**
   * 🔴 **目次は `<a href="#…">` にしない**(2026-08-31、実ブラウザの probe で判明)。
   * ⚠ この窓は `about:blank` で**開いた側の base URL を引き継ぐ**ので、素の断片
   *   リンクを押すと窓が**アプリ本体へ navigate** し、マニュアルが丸ごと消える。
   */
  it('🔴 目次の行は navigate しない(button で出す)', () => {
    const doc = blankDoc();
    fillManualWindow(doc, {
      title: 't',
      version: 'v',
      html: HTML,
      text: TEXT,
      sections: manualSections(TEXT),
    });
    const toc = doc.querySelector('[data-pkc-region="manual-window-toc"]')!;
    expect(toc.querySelectorAll('a'), '目次にリンクが在る(押すと窓が飛ぶ)').toHaveLength(0);
    expect(toc.querySelectorAll('button').length).toBe(3);
  });

  it('🔴 h4 も目次に出る(段付けが読める)', () => {
    const doc = blankDoc();
    fillManualWindow(doc, {
      title: 't',
      version: 'v',
      html: HTML,
      text: TEXT,
      sections: manualSections(TEXT),
    });
    const levels = [
      ...doc.querySelectorAll('[data-pkc-region="manual-window-toc"] button'),
    ].map((b) => b.getAttribute('data-pkc-level'));
    expect(levels).toEqual(['1', '2', '4']);
  });

  it('本文は器いっぱいの面に入る(60vh の箱を持ち込まない)', () => {
    const doc = blankDoc();
    fillManualWindow(doc, { title: 't', version: 'v', html: HTML, text: TEXT, sections: [] });
    const main = doc.querySelector('[data-pkc-region="manual-window-main"]')!;
    // ⚠ 本文の見た目は `.pkc-md-rendered` 起点の規則が持つ ── 器の class が要る
    expect(main.className).toContain('pkc-md-rendered');
    expect(main.innerHTML).toContain('<h1');
    // 🔴 ヘルプ面の箱の名前を持ち込んでいないこと(持ち込むと 60vh が効く)
    expect(doc.body.innerHTML).not.toContain('help-manual');
  });

  it('帯に題名と版と、Ctrl+F が使える旨が出る', () => {
    const doc = blankDoc();
    fillManualWindow(doc, {
      title: MANUAL_WINDOW_TITLE,
      version: 'PKC3 v9.9.9(開発版)',
      html: HTML,
      text: TEXT,
      sections: manualSections(TEXT),
    });
    const head = doc.querySelector('[data-pkc-field="manual-window-head"]')!;
    expect(head.textContent).toContain(MANUAL_WINDOW_TITLE);
    expect(head.textContent).toContain('PKC3 v9.9.9(開発版)');
    expect(head.textContent, 'この窓の取り分が書かれていない').toContain('Ctrl+F');
    expect(doc.title).toBe(MANUAL_WINDOW_TITLE);
  });

  it('🔴 描けなかったら素の原文を出す ── そのとき目次は出さない', () => {
    const doc = blankDoc();
    fillManualWindow(doc, {
      title: 't',
      version: 'v',
      html: '',
      text: TEXT,
      sections: manualSections(TEXT),
    });
    expect(doc.querySelector('[data-pkc-field="manual-window-raw"]')?.textContent).toBe(TEXT);
    // ⚠ 飛び先が 1 つも無いので、目次を出すと**全部 dead click** になる
    expect(doc.querySelectorAll('[data-pkc-region="manual-window-toc"] button')).toHaveLength(0);
  });
});

describe('マニュアルの窓 — 開き方', () => {
  const parts = {
    title: MANUAL_WINDOW_TITLE,
    version: 'v',
    text: TEXT,
    sections: manualSections(TEXT),
  };

  it('🔴 塞がれたら null(呼び側が理由を言える)。描画も呼ばない', async () => {
    const render = vi.fn(async () => HTML);
    const got = await openManualWindow({ ...parts, render, open: () => null });
    expect(got).toBeNull();
    // ⚠ 開けていないのに描くと、ワーカーを無駄に起こす
    expect(render).not.toHaveBeenCalled();
  });

  it('🔴 開いた瞬間から「開いています」と出る(白紙を見せない)', async () => {
    const win = fakeWin();
    let seen = '';
    const done = openManualWindow({
      ...parts,
      open: () => win,
      render: async (t) => {
        // ⚠ 描いている**最中**の窓を見る
        seen = win.document.body.textContent ?? '';
        return `<h1>${t.slice(2, 3)}</h1>`;
      },
    });
    await done;
    expect(seen).toContain('マニュアルを開いています');
  });

  it('固定の名前で開く(ブラウザが同じ窓を返せるようにする)', async () => {
    const win = fakeWin();
    const seen: Array<{ url: string; target: string; features: string }> = [];
    await openManualWindow({
      ...parts,
      open: (url, target, features) => {
        seen.push({ url, target, features });
        return win;
      },
      render: async () => HTML,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe(MANUAL_WINDOW_NAME);
    // ⚠ `popup` と寸法を渡さないと別タブになるブラウザが在る
    expect(seen[0]!.features).toContain('popup');
    /**
     * 🔴 **URL は空**(2026-08-31 実測)── `'about:blank'` を渡すと、名前つきの窓を
     * **navigate し直す**ので、**2 回目に押すたび中身が丸ごと消える**
     * (実ブラウザで確かめた。`manual-window.ts` の表)。
     */
    expect(seen[0]!.url, 'about:blank を渡すと 2 回目に中身が消える').toBe('');
  });

  /**
   * 🔴 **2 回目は組み直さない**(着地前の設計レビューが拾った)。
   *
   * ⚠ この test の 1 稿目は題を「**2 回押しても 2 枚積まない**」としながら
   *   `openManualWindow` を **1 回しか呼んでいなかった** ── `toHaveLength(1)` は
   *   「1 回呼んだから 1 回」を見ているだけで、**題が嘘**だった(レビュー指摘)。
   * 🔑 だから**本当に 2 回押す**。組み直すと、user は**読んでいた所を見失う**。
   */
  it('🔴 2 回目に押しても組み直さない(読んでいた所を失わない)', async () => {
    const win = fakeWin();
    let focused = 0;
    (win as unknown as { focus: () => void }).focus = () => {
      focused += 1;
    };
    let rendered = 0;
    const deps = {
      ...parts,
      open: () => win,
      render: async () => {
        rendered += 1;
        return HTML;
      },
    };
    const opened = await openManualWindow(deps);
    const first = win.document.querySelector('[data-pkc-region="manual-window-main"]');
    expect(rendered, '1 回目で描いていない(前提が崩れている)').toBe(1);
    // ⚠ **対照群** ── 1 回目は「前へ出しただけ」ではない(規則そのものが生きている)
    expect(opened?.reused, '1 回目から「前へ出しただけ」と言っている').toBe(false);

    const again = await openManualWindow(deps);
    expect(rendered, '2 回目に描き直している(ワーカーを無駄に起こす)').toBe(1);
    expect(focused, '前へ出していない').toBe(1);
    /**
     * 🔴 **「前へ出しただけ」を呼び側へ返す** ── `focus()` が手前へ出せるかは
     * ブラウザ次第なので、返さないと**押しても何も起きない**回が生まれる。
     */
    expect(again?.reused, '前へ出しただけ、を呼び側へ言っていない').toBe(true);
    expect(
      win.document.querySelector('[data-pkc-region="manual-window-main"]'),
      '本文を組み直している(読んでいた所が飛ぶ)',
    ).toBe(first);
  });

  /**
   * 🔴 **対照群 ── 版が上がったら組み直す**。
   * ⚠ これが無いと「常に組み直さない」実装でも上の test は通る ── そして
   *   アプリを更新しても**古い本文の窓が前に出続ける**。
   */
  it('🔴 版が上がったら組み直す(古い本文を出し続けない)', async () => {
    const win = fakeWin();
    (win as unknown as { focus: () => void }).focus = () => {};
    let rendered = 0;
    const render = async (): Promise<string> => {
      rendered += 1;
      return HTML;
    };
    await openManualWindow({ ...parts, version: 'v1', open: () => win, render });
    await openManualWindow({ ...parts, version: 'v2', open: () => win, render });
    expect(rendered, '版が変わったのに組み直していない').toBe(2);
    expect(win.document.querySelector('[data-pkc-field="manual-window-head"]')?.textContent).toContain(
      'v2',
    );
    // ⚠ 組み直しで style が積み上がらないこと(head を入れ替えている)
    expect(win.document.querySelectorAll('style')).toHaveLength(1);
  });

  it('🔴 描いている間に閉じられたら、その窓に触らない', async () => {
    const win = fakeWin();
    const got = await openManualWindow({
      ...parts,
      open: () => win,
      render: async () => {
        win.closed = true;
        return HTML;
      },
    });
    expect(got).toBeNull();
    expect(win.document.querySelector('[data-pkc-region="manual-window-main"]')).toBeNull();
  });

  it('🔴 描画が落ちても窓は残す(素の原文へ落ちる)', async () => {
    const win = fakeWin();
    const got = await openManualWindow({
      ...parts,
      open: () => win,
      render: async () => {
        throw new Error('worker down');
      },
    });
    expect(got).not.toBeNull();
    expect(win.document.querySelector('[data-pkc-field="manual-window-raw"]')?.textContent).toBe(
      TEXT,
    );
  });
});

/**
 * 🔴 **ヘルプの中のボタンから、窓の口までが繋がっている**(#645)。
 *
 * ⚠ **ここが「A と B の合意」を見る唯一の場所**である(CLAUDE.md §7)──
 *   ボタンを出す側(`help.ts`)の test は DOM しか見ず、窓を組む側
 *   (`manual-window.ts`)の test は document しか見ない。**その間の配線**は
 *   どちらの test にも書けない。
 */
describe('マニュアルの窓 — ヘルプのボタンから窓の口まで', () => {
  function setup(services: BinderServices) {
    const root = document.createElement('div');
    document.body.append(root);
    const region = document.createElement('div');
    root.append(region);
    new HelpRenderer(region).render();
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const errors: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = (a: Parameters<Dispatcher['dispatch']>[0]) => {
      if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
      return orig(a);
    };
    bindActions(root, d, services);
    return { root, errors };
  }

  it('🔴 押すと、窓の口が呼ばれる', () => {
    let called = 0;
    const { root, errors } = setup({
      openManualWindow: () => {
        called += 1;
      },
    });
    root.querySelector<HTMLElement>('[data-pkc-action="open-manual-window"]')!.click();
    expect(called, 'ヘルプのボタンから窓の口へ繋がっていない').toBe(1);
    expect(errors, '押せたのに理由が出た').toEqual([]);
  });

  /**
   * 🔴 **無言で終えない**(変異試験 M12 が SURVIVED で教えた)。
   * ⚠ 配線が落ちた版でも、押した手応えは返す ── 「押しても何も起きない」を作らない。
   */
  it('🔴 配線が無い版では、理由を出す(黙らない)', () => {
    const { root, errors } = setup({});
    root.querySelector<HTMLElement>('[data-pkc-action="open-manual-window"]')!.click();
    expect(errors).toEqual(['この版ではマニュアルのウィンドウを開けません']);
  });
});
