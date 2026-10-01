/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列を畳んでも、帯の操作が縁に残る**(#582。🟣 Gemini 裁定 2026-10-01 = 案 A)。
 *
 * user から見て何が起きていたか:左の列を境目の帯で畳むと、列の下の
 * 取り込む / バックアップ / 操作を探す / 集計 / システム / フラグ / ヘルプが**道連れで消え**、
 * マウスだけの人は設定に辿り着けなかった(#197「畳んでも操作子が消えてはいけない」の穴)。
 *
 * 守る主張:
 * 1. 畳むと縁に**帯と同じ操作が同じ順で**出る(登記簿が 2 つに割れていない)
 * 2. 縁の各ボタンは**図案だけ**でも名前を持つ(`aria-label` / `title`)── 字は帯と等しい
 * 3. 戻すと縁は**器ごと消える**(帯は今までどおり)── 双方向
 * 4. 縁のボタンを押すと、帯のボタンと**同じ受け手**に届く(binder 経由)
 * 5. 縁の幅は 40px(縁 32px + 掴む帯 8px)で、畳んだ版面 3 つが同じ変数を読む
 *
 * ⚠ happy-dom は CSS を組まない ── 描いた幅は `tests/smoke/pane-resize.smoke.spec.ts` が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { collectionBarItems, markCollectionView } from '../../src/adapter/ui/render/collection-bar';
import { codeOnly } from '../helpers/code-only';
import { blocksFor, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';

const EDGE = '[data-pkc-region="collapsed-edge"]';

function mounted() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  bindActions(root, d);
  return { root, d };
}

/** 帯の押し所を並び順のまま。⚠ 入力欄の `import-input` は `button` ではないので混ざらない。 */
const barButtons = (root: HTMLElement): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>('[data-pkc-region="collection-bar"] button'),
];
const edgeButtons = (root: HTMLElement): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>(`${EDGE} button`),
];
/** 受け手を決める鍵(action と、`set-view` の行き先)。 */
const keyOf = (b: HTMLElement): string =>
  `${b.getAttribute('data-pkc-action')}|${b.getAttribute('data-pkc-view') ?? ''}`;
const labelOf = (b: HTMLElement): string =>
  b.querySelector('[data-pkc-field="label"]')?.textContent ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('畳むと縁に出て、戻すと消える', () => {
  it('🔴 畳むと縁に帯と同じ操作が同じ順で出る(登記簿が 2 つに割れていない)', () => {
    const { root } = mounted();
    expect(root.querySelector(EDGE), '畳む前から縁が在る').toBeNull();
    const bar = barButtons(root);
    // ⚠ 空振り防止 ── 帯が空なら「同じ」は常に成り立つ(7 つ: 取り込む / バックアップ /
    //   操作を探す / 集計 / システム / フラグ / ヘルプ)
    expect(bar.length, '帯のボタンが少なすぎる(台の空振り)').toBeGreaterThan(5);

    applyPaneVisibility(root, ['sidebar']);
    const edge = edgeButtons(root);
    expect(edge.length, '縁にボタンが出ていない').toBe(bar.length);
    expect(edge.map(keyOf), '縁の操作が帯と違う(順も含めて等しいこと)').toEqual(bar.map(keyOf));
  });

  it('🔴 縁の各ボタンは名前を持ち、字と説明は帯と等しい', () => {
    const { root } = mounted();
    const bar = barButtons(root);
    applyPaneVisibility(root, ['sidebar']);
    const edge = edgeButtons(root);
    expect(edge.length).toBe(bar.length);
    edge.forEach((b, i) => {
      const k = keyOf(b);
      expect(b.getAttribute('aria-label'), `${k}: 読み上げの名前が無い`).toBe(labelOf(bar[i]!));
      expect(b.getAttribute('aria-label')!.length, `${k}: 名前が空`).toBeGreaterThan(0);
      expect(b.title, `${k}: hover の説明が無い / 帯と違う`).toBe(bar[i]!.title);
      expect(b.title.length, `${k}: 説明が空`).toBeGreaterThan(0);
      // 図案だけのタイル(帯と同じ部品)── 見た目の寸法はこの印が決める
      expect(b.hasAttribute('data-pkc-bar-tile'), `${k}: タイルの印が無い`).toBe(true);
    });
  });

  it('🔴 戻すと縁は器ごと消え、帯は今までどおり残る', () => {
    const { root } = mounted();
    const before = barButtons(root).map(keyOf);
    applyPaneVisibility(root, ['sidebar']);
    expect(edgeButtons(root).length).toBeGreaterThan(5);
    applyPaneVisibility(root, []);
    expect(root.querySelector(EDGE), '戻したのに縁が残っている').toBeNull();
    expect(edgeButtons(root), '戻したのに縁のボタンが残っている').toEqual([]);
    expect(barButtons(root).map(keyOf), '戻したら帯が変わった').toEqual(before);
  });

  it('🔴 右の列だけ畳んでも縁は出ない(縁は左の列の帯の代わり)', () => {
    const { root } = mounted();
    applyPaneVisibility(root, ['inspector']);
    expect(root.querySelector(EDGE), '右を畳んだだけで縁が出た').toBeNull();
    applyPaneVisibility(root, ['sidebar', 'inspector']);
    expect(edgeButtons(root).length, '両方畳むと縁が出ない').toBeGreaterThan(5);
    applyPaneVisibility(root, ['inspector']);
    expect(root.querySelector(EDGE), '左だけ戻したのに縁が残った').toBeNull();
  });

  it('🔴 畳んだまま描き直しても、縁は作り直さない(押している最中の焦点を飛ばさない)', () => {
    const { root } = mounted();
    applyPaneVisibility(root, ['sidebar']);
    const first = root.querySelector(EDGE);
    const btn = edgeButtons(root)[0];
    applyPaneVisibility(root, ['sidebar']);
    expect(root.querySelector(EDGE), '縁が作り直された').toBe(first);
    expect(edgeButtons(root)[0], 'ボタンが作り直された').toBe(btn);
    expect(root.querySelectorAll(EDGE).length, '縁が 2 つになった').toBe(1);
  });

  it('🔴 縁は shell の直下で、左の列の外に在る(列と一緒に消えない)', () => {
    const { root } = mounted();
    applyPaneVisibility(root, ['sidebar']);
    const edge = root.querySelector<HTMLElement>(EDGE)!;
    expect(edge.parentElement?.getAttribute('data-pkc-region')).toBe('shell');
    expect(edge.closest('[data-pkc-region="sidebar"]'), '縁が畳む列の中に在る').toBeNull();
    // 鍵の受け手(`SHORTCUT_BUTTON` の `querySelector`)が引く 1 件目は、従来どおり列の側
    const settings = root.querySelector('[data-pkc-action="set-view"][data-pkc-view="settings"]')!;
    expect(settings.closest('[data-pkc-region="sidebar"]'), '鍵の押し先が縁へ移った').not.toBeNull();
  });
});

describe('押すと帯と同じ受け手に届く', () => {
  it('🔴 縁の「システム」を押すと、帯の「システム」と同じ面が開く', () => {
    const viaBar = mounted();
    viaBar.root
      .querySelector<HTMLElement>(
        '[data-pkc-region="collection-bar"] [data-pkc-action="set-view"][data-pkc-view="settings"]',
      )!
      .click();
    const want = viaBar.d.getState().viewMode;
    expect(want, '帯から押しても開かない(台の空振り)').toBe('settings');

    document.body.innerHTML = '';
    const viaEdge = mounted();
    applyPaneVisibility(viaEdge.root, ['sidebar']);
    expect(viaEdge.d.getState().viewMode, '押す前から開いている(台の前提)').not.toBe('settings');
    viaEdge.root
      .querySelector<HTMLElement>(`${EDGE} [data-pkc-action="set-view"][data-pkc-view="settings"]`)!
      .click();
    expect(viaEdge.d.getState().viewMode, '縁から押しても開かない').toBe(want);
  });

  it('🔴 縁のボタンは 1 つ残らず、受け手の在る action を名乗っている(押して無反応を作らない)', () => {
    const { root } = mounted();
    applyPaneVisibility(root, ['sidebar']);
    const binder = readFileSync(
      join(__dirname, '../../src/adapter/ui/actions/binder.ts'),
      'utf-8',
    );
    for (const b of edgeButtons(root)) {
      const action = b.getAttribute('data-pkc-action')!;
      expect(binder, `${action} を受ける口が binder に無い`).toContain(`'${action}':`);
    }
  });
});

describe('縁は帯と同じ一覧から射影される(別の一覧を持たない)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@features/sealed');
  });

  /**
   * 🔴 **封印を変えると、帯と縁が一緒に変わる**。⚠ 縁が手書きの配列なら、帯だけが変わる。
   * (`SEALED_VIEWS` に `flags` を入れた版を作り、両方から「フラグ」が消えることを見る)
   */
  it('🔴 一覧から 1 つ落とすと、帯と縁の両方から落ちる', async () => {
    vi.resetModules();
    vi.doMock('@features/sealed', () => ({
      SEALED_ARCHETYPES: [],
      SEALED_VIEWS: ['flags'],
      SEAL_REASON: '',
      SEALED_TEST_NOTES: '',
      isSealedArchetype: () => false,
      isSealedView: (v: string) => v === 'flags',
    }));
    const { buildShell: build } = await import('../../src/adapter/ui/render/shell');
    const { applyPaneVisibility: apply } = await import(
      '../../src/adapter/ui/render/pane-visibility'
    );
    const root = document.createElement('div');
    document.body.append(root);
    build(root);
    apply(root, ['sidebar']);
    const bar = barButtons(root).map(keyOf);
    const edge = edgeButtons(root).map(keyOf);
    expect(bar.length, '帯が空(台の空振り)').toBeGreaterThan(4);
    expect(bar, '封印した view が帯に残っている(台の前提)').not.toContain('set-view|flags');
    expect(edge, '縁だけ封印した view を出している(別の一覧を持っている)').toEqual(bar);
  });

  it('🔴 縁を組む file は、操作の字・action を 1 つも自分では書いていない', () => {
    const code = codeOnly(
      readFileSync(join(__dirname, '../../src/adapter/ui/render/collapsed-edge.ts'), 'utf-8'),
    );
    expect(code.length, 'コメント落としが本体まで消した').toBeGreaterThan(500);
    expect(code, '一覧から引いていない').toContain('collectionBarItems()');
    expect(code, '帯と同じ関数で組んでいない').toContain('collectionBarButton(');
    for (const word of collectionBarItems().flatMap((i) => [i.action, i.label])) {
      expect(code, `縁の file に「${word}」を手で書いている(登記簿が 2 つになる)`).not.toContain(
        `'${word}'`,
      );
    }
  });
});

describe('縁の幅(CSS の原文)', () => {
  const css = stripComments(readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8'));
  const desktop = withoutMedia(css);

  const edgeW = (src: string): number | null => {
    const m = /--pkc-edge-w:\s*(\d+)px/.exec(src);
    return m ? Number(m[1]) : null;
  };

  it('🔴 縁の幅は 40px 以下で、タイル 32px + 掴む帯 8px に一致する', () => {
    const shell = blocksFor(desktop, "[data-pkc-region='shell']").join('\n');
    const w = edgeW(shell);
    expect(w, '`--pkc-edge-w` が読めない(空振り)').not.toBeNull();
    expect(w!, '縁が太った(目安 40px 以下)').toBeLessThanOrEqual(40);
    // タイルの寸法(`[data-pkc-bar-tile]`)と帯の幅から組んだ値と等しい
    const tile = Number(/width:\s*(\d+)px/.exec(blocksFor(desktop, '[data-pkc-bar-tile]').join('\n'))?.[1]);
    expect(tile, 'タイルの幅が読めない').toBeGreaterThan(0);
    expect(w, '縁 = タイル + 掴む帯(8px)から外れた').toBe(tile + 8);
  });

  it('🔴 左を畳む 3 つの版面は、1 列目を縁の幅にする(8px のままだと縁がはみ出る)', () => {
    const tabletBody = mediaBlock(css, '(max-width: 1100px)').body;
    const rules: [string, string][] = [
      ["[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar']", desktop],
      [
        "[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar'][data-pkc-hidden-panes~='inspector']",
        desktop,
      ],
      ["[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar']", tabletBody],
    ];
    for (const [sel, src] of rules) {
      const hit = blocksFor(src, sel).filter((b) => /grid-template-columns/.test(b));
      expect(hit.length, `${sel} の版面が読めない(空振り)`).toBeGreaterThan(0);
      for (const b of hit) {
        const cols = /grid-template-columns:\s*([^;]+);/.exec(b)![1]!;
        expect(cols.trim().startsWith('var(--pkc-edge-w)'), `1 列目が縁の幅でない: ${cols}`).toBe(
          true,
        );
      }
    }
  });

  it('🔴 縁は掴む帯と同じマス(gripl)に載り、帯は右端の 8px のまま', () => {
    const edge = blocksFor(desktop, "[data-pkc-region='collapsed-edge']").join('\n');
    expect(edge, '縁が gripl に載っていない').toMatch(/grid-area:\s*gripl/);
    expect(edge, '縁の幅が縁の変数から外れた').toMatch(/width:\s*calc\(var\(--pkc-edge-w\)\s*-\s*8px\)/);
    const grip = blocksFor(
      desktop,
      "[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar'] [data-pkc-region='pane-grip'][data-pkc-pane='sidebar']",
    ).join('\n');
    expect(grip, '畳んだ帯が右端へ寄っていない').toMatch(/justify-self:\s*end/);
    expect(grip, '畳んだ帯が 8px でない').toMatch(/width:\s*8px/);
  });
});

describe('🔴 いま開いている面の印が、縁のボタンにも付く(#1206 D1)', () => {
  /** 印が付いている面の名前(`data-pkc-view`)を並び順のまま。 */
  const activeViews = (btns: HTMLElement[]): string[] =>
    btns
      .filter((b) => b.hasAttribute('data-pkc-active'))
      .map((b) => b.getAttribute('data-pkc-view') ?? '');

  it('🔴 畳んだ後に面が変わると、縁の「そのボタン」だけに印が付き、帯の印も今までどおり', () => {
    const { root } = mounted();
    applyPaneVisibility(root, ['sidebar']);
    markCollectionView(root, 'settings');
    expect(activeViews(edgeButtons(root)), '縁のボタンに印が付かない').toEqual(['settings']);
    expect(activeViews(barButtons(root)), '帯(対照群)の印が変わった').toEqual(['settings']);
    markCollectionView(root, 'help');
    expect(activeViews(edgeButtons(root)), '面を変えても縁の印が動かない').toEqual(['help']);
    expect(activeViews(barButtons(root))).toEqual(['help']);
  });

  it('🔴 畳んだ「後」に縁を作ったとき、いまの印を当て直す(作り直しで印が消えない)', () => {
    const { root } = mounted();
    // 畳む前に面が決まっている ── main.ts の markView は同じ面なら早く戻るので、
    // 縁を作るとき自身が現在の印を写さないと、畳んだ直後の縁には印が無い
    markCollectionView(root, 'settings');
    expect(root.querySelector(EDGE), '前提: まだ縁が無い').toBeNull();
    applyPaneVisibility(root, ['sidebar']);
    expect(activeViews(edgeButtons(root))).toEqual(['settings']);
    // 戻して面を変え、畳み直しても同じ
    applyPaneVisibility(root, []);
    markCollectionView(root, 'help');
    applyPaneVisibility(root, ['sidebar']);
    expect(activeViews(edgeButtons(root)), '畳み直した縁が古い面の印を持っている').toEqual(['help']);
  });

  it('面が「ノート」のとき(印を持つボタンが無い)は縁にも印が付かない', () => {
    const { root } = mounted();
    markCollectionView(root, 'detail');
    applyPaneVisibility(root, ['sidebar']);
    expect(activeViews(edgeButtons(root))).toEqual([]);
    expect(activeViews(barButtons(root))).toEqual([]);
  });
});
