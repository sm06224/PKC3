/** @vitest-environment happy-dom */
/**
 * 🔴 **文字の大きさ**(#504。user 指示 2026-08-28
 * 「**正直変更はユーザーに委ねて欲しい**」)。
 *
 * 見るのは 4 点:
 * ① 🔴 **既定が現行そのまま**(選ばなければ見え方が 1 バイトも変わらない)
 * ② 当てると DOM に印と値が乗る(画面が正本)
 * ③ 🔴 **当てるだけでは保存しない**(起動時の適用が「選んでいないのに固定」を作らない)
 * ④ 保存が読めない環境でも落ちない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import {
  DEFAULT_TEXT_SCALE,
  isTextScale,
  TEXT_SCALES,
  textScaleSpec,
} from '../../src/features/text-scale';
import {
  applyTextScale,
  chooseTextScale,
  chosenTextScale,
  currentTextScale,
  initialTextScale,
  TEXT_SCALE_ATTR,
  TEXT_SIZE_VAR,
} from '../../src/adapter/ui/render/text-scale';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(TEXT_SCALE_ATTR);
  document.documentElement.style.removeProperty(TEXT_SIZE_VAR);
});

describe('文字の大きさの表', () => {
  /**
   * 🔴 **既定は現行そのまま**(`app.css` の `body { font-size: var(--pkc-text-size, 13px) }`
   * の**既定値**と同じ)。⚠ ここがずれると、**設定を触っていない user の画面が動く**
   * ── 今回の裁定(見え方を勝手に変えない)に正面から反する。
   */
  it('🔴 既定「標準」は 13px ── 選ばなければ見え方が変わらない', () => {
    expect(DEFAULT_TEXT_SCALE).toBe('standard');
    expect(textScaleSpec(DEFAULT_TEXT_SCALE).size).toBe('13px');
  });

  it('🔴 CSS の既定値が、表の「標準」と同じ値である(2 本目の数字を置かない)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf-8');
    // ⚠ **実行する行**を見る(コメントに満たされない形。CLAUDE.md §1)
    const m = /font-size:\s*var\(--pkc-text-size,\s*([^)]+)\)/.exec(css);
    expect(m, 'body の font-size が変数を通っていない').not.toBeNull();
    expect(m![1]!.trim(), 'CSS の既定値と表の「標準」がずれている').toBe(
      textScaleSpec('standard').size,
    );
  });

  it('4 段だけで、大きさが単調に増える(選ばせる幅を絞る)', () => {
    expect(TEXT_SCALES).toHaveLength(4);
    const px = TEXT_SCALES.map((t) => Number.parseFloat(t.size));
    for (let i = 1; i < px.length; i++) {
      expect(px[i]!, `${TEXT_SCALES[i]!.id} が 1 つ前より小さい`).toBeGreaterThan(px[i - 1]!);
    }
  });

  it('知らない id は既定へ落ちる(呼び側で分岐させない)', () => {
    expect(isTextScale('huge')).toBe(false);
    expect(textScaleSpec('huge' as never).id).toBe('standard');
  });
});

describe('当てる / 選ぶ / 起動時に戻す', () => {
  it('当てると印と値が DOM に乗る(画面が正本)', () => {
    applyTextScale(document.documentElement, 'large');
    expect(document.documentElement.getAttribute(TEXT_SCALE_ATTR)).toBe('large');
    expect(document.documentElement.style.getPropertyValue(TEXT_SIZE_VAR)).toBe('15px');
    expect(currentTextScale(document.documentElement)).toBe('large');
  });

  /**
   * 🔴 **当てるだけでは保存しない**(`page-format.ts` / `theme.ts` と同じ理由)。
   * ⚠ 起動時の適用で保存すると、**一度も選んでいないのに固定される** ──
   *   既定を後で変えたときに、その user だけ古い値のまま取り残される。
   */
  it('🔴 当てるだけでは保存しない / 選んだときだけ保存する', () => {
    applyTextScale(document.documentElement, 'large');
    expect(localStorage.getItem('pkc3.text-scale'), '当てただけで保存した').toBeNull();
    // 対照群 ── 選べば保存され、次の起動で戻る
    chooseTextScale(document.documentElement, 'xlarge');
    expect(localStorage.getItem('pkc3.text-scale')).toBe('xlarge');
    expect(initialTextScale()).toBe('xlarge');
  });

  it('保存が壊れていても既定へ落ちる(起動を止めない)', () => {
    localStorage.setItem('pkc3.text-scale', 'ばかでかい');
    expect(initialTextScale()).toBe('standard');
    // 印が無い DOM も既定として読む
    expect(currentTextScale(document.documentElement)).toBe('standard');
  });

  /**
   * ⚠ **読み幅は動かない**ことを、値の側で pin する ── `--read-w` は `rem`
   *   (`html` 基準)なので、`body` を動かしても 1px も変わらない。
   * 🔑 これが崩れると**図が焼き直る**(ラスタの鍵は器の幅を含む ── 不可侵指示
   *   2026-08-03)ので、当てる先が `html` へ移っていないことをここで止める。
   */
  it('🔴 当てる先は body の font-size(html を動かして読み幅まで変えない)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf-8');
    const codeOnly = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly, 'body が変数を通っていない').toMatch(
      /body\s*\{[^}]*font-size:\s*var\(--pkc-text-size/,
    );
    expect(codeOnly, 'html / :root の font-size を動かしている(読み幅まで動く)').not.toMatch(
      /(^|\})\s*(html|:root)\s*\{[^}]*font-size:/,
    );
  });
});

/**
 * 🔴 **設定画面から実体まで繋がっているか**(#504)。
 *
 * ⚠ **合成した `<select>` を押さない**(`page-format.test.ts` の注記そのまま)──
 *   自分で作った要素に自分で `data-pkc-action` を付けて押すと、**本物の設定画面が
 *   その action を付け忘れても緑**になる。
 * 🔑 `SettingsRenderer` が組んだ**本物の選択欄**を binder の下に置いて押す。
 */
describe('文字の大きさ(設定画面と配線)', () => {
  function pane(): { region: HTMLElement; settings: SettingsRenderer } {
    const region = document.createElement('div');
    document.body.append(region);
    // ⚠ 監視器は自分で `new` して渡す(共有の 1 個を汚さない)
    const settings = new SettingsRenderer(region, new JobMonitor());
    return { region, settings };
  }

  it('選択肢が表と 1 対 1(選べない大きさ・在らない大きさを作らない)', () => {
    const { region, settings } = pane();
    settings.render(initialState);
    const opts = [
      ...region.querySelectorAll<HTMLOptionElement>('[data-pkc-field="text-scale-select"] option'),
    ];
    expect(opts.map((o) => o.value)).toEqual(TEXT_SCALES.map((t) => t.id));
    expect(opts.map((o) => o.textContent)).toEqual(TEXT_SCALES.map((t) => t.label));
  });

  /**
   * 🔴 **組み立てのときも映す**(変異試験 M8 が SURVIVED で教えた)。器は 1 度しか
   * 組まないので、起動時に保存から復元した値をここで映さないと、選択欄は既定の
   * まま = **画面が嘘をつく**(「設定したのに戻っている」と読まれる)。
   */
  it('🔴 組み立て直後の選択欄が、いま当たっている値を映す', () => {
    applyTextScale(document.documentElement, 'xlarge');
    const { region, settings } = pane();
    settings.render(initialState);
    const select = region.querySelector<HTMLSelectElement>('[data-pkc-field="text-scale-select"]');
    expect(select?.value).toBe('xlarge');
    // 対照群 ── 別の値でも映る(1 つに固まっているのではない)
    applyTextScale(document.documentElement, 'small');
    settings.render(initialState);
    expect(select?.value).toBe('small');
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const dispatcher = { getState: () => initialState, dispatch: vi.fn() };
    bindActions(root, dispatcher as never, {});
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="text-scale-select"]');
    expect(select, '設定画面に文字の大きさの選択欄が無い').not.toBeNull();
    select!.value = 'large';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    // 🔑 実体は DOM(押した結果が画面に当たっている)
    expect(currentTextScale(document.documentElement)).toBe('large');
    expect(localStorage.getItem('pkc3.text-scale'), '押したのに憶えていない').toBe('large');
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(CLAUDE.md「どの test からも実行され
 * ない file に判断を書かない」)。見るのは **1 本の配線** ── 起動時に当てること。
 * ⚠ 弱い pin だと自覚して使う(綴りが合っていることしか見ていない)。
 */
describe('main.ts の配線(原文 pin)', () => {
  it('🔴 起動時に、保存された大きさを当てている', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code, '起動時に当てていない(選んでも次の起動で戻る)').toMatch(
      /applyTextScale\(document\.documentElement,\s*initialTextScale\(\)\)/,
    );
  });
});

/**
 * 🔴 **「選んだか」と「効いているか」は別の問い**(2026-09-02 hotfix、#648)。
 *
 * 焼いたマニュアル(`manual-page.ts` の boot script)は**選んでいなければ触らない**
 * (読み物なので 14px のまま)。窓へ当て直す側(`main.ts` の `currentAppearance`)が
 * 「効いている既定 13px」を渡すと、**何も変えずにもう一度押しただけで字が縮む**。
 * 🔑 だから当て直す側は boot script と同じ門(`chosenTextScale`)で読む。
 */
describe('選んだ大きさ(chosenTextScale)', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-pkc-text-scale');
    document.documentElement.style.removeProperty('--pkc-text-size');
  });

  it('🔴 選んでいなければ null(効いている既定を「選んだ」と読まない)', () => {
    applyTextScale(document.documentElement, 'standard');
    expect(chosenTextScale(), '当てただけで「選んだ」になっている').toBeNull();
    // 対照群 ── 選べば id が返る
    chooseTextScale(document.documentElement, 'large');
    expect(chosenTextScale()).toBe('large');
  });

  it('保存が壊れていれば null(boot script も同じ値では触らない)', () => {
    localStorage.setItem('pkc3.text-scale', 'ばかでかい');
    expect(chosenTextScale()).toBeNull();
    expect(initialTextScale(), '起動側は既定へ落ちる').toBe('standard');
  });

  /**
   * 🔴 **「標準」を選ぶと鍵が消える**(#656 ①)。
   * ⚠ 直す前は `'standard'` も保存していた ── 一度「大」を試すと、「標準」へ戻しても
   *   `chosenTextScale()` が「選んだ」と読み続け、**選んでいない状態へ二度と戻れなかった**。
   * 🔑 観測点は鍵そのもの(`localStorage`)── `chosenTextScale()` だけ見ると、
   *   「`'standard'` を null に読み替える」実装でも通る(鍵は残る)。
   */
  it('🔴 「標準」を選ぶと鍵が消える(選んでいない状態へ戻る)', () => {
    // 対照群 ── 「大」を選べば鍵が書かれる(規則そのものが生きている)
    chooseTextScale(document.documentElement, 'large');
    expect(localStorage.getItem('pkc3.text-scale'), '前提が崩れている(大を選んでも鍵が無い)').toBe(
      'large',
    );
    chooseTextScale(document.documentElement, 'standard');
    expect(localStorage.getItem('pkc3.text-scale'), '「標準」を選んだのに鍵が残っている').toBeNull();
    expect(chosenTextScale(), '窓へ当て直す側が「選んだ」と読む').toBeNull();
    // ⚠ 画面には当たっている(鍵を消しただけで、見え方は既定のまま)
    expect(currentTextScale(document.documentElement)).toBe(DEFAULT_TEXT_SCALE);
    expect(initialTextScale(), '次の起動は既定へ落ちる').toBe(DEFAULT_TEXT_SCALE);
  });

  it('保存できない環境でも「標準」を選べる(removeItem が投げても落ちない)', () => {
    const orig = Storage.prototype.removeItem;
    Storage.prototype.removeItem = () => {
      throw new Error('denied');
    };
    try {
      expect(() => chooseTextScale(document.documentElement, 'standard')).not.toThrow();
      expect(currentTextScale(document.documentElement)).toBe('standard');
    } finally {
      Storage.prototype.removeItem = orig;
    }
  });

  /**
   * ⚠ 原文 pin(`main.ts` はどの test からも実行されない)。見るのは 1 点 ──
   *   マニュアルの窓へ渡す大きさを、**効いている値**ではなく**保存**から読んでいること。
   */
  it('🔴 main.ts はマニュアルの窓へ渡す大きさを保存(chosenTextScale)から読む', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const from = code.indexOf('function currentAppearance(');
    const to = code.indexOf('function openManualTile(');
    expect(from, 'currentAppearance が無い(空振り)').toBeGreaterThan(-1);
    expect(to, 'openManualTile が無い(空振り)').toBeGreaterThan(from);
    const fn = code.slice(from, to);
    expect(fn).toMatch(/chosenTextScale\(\)/);
    expect(
      fn,
      '効いている値(root.style)を渡している ── 何も変えずに押しただけで 14px → 13px に縮む',
    ).not.toMatch(/getPropertyValue\(\s*['"]--pkc-text-size['"]\s*\)/);
  });
});
