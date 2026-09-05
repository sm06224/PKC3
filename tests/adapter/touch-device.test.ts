/** @vitest-environment happy-dom */
/**
 * 🔴 **指で触るだけの端末では、鍵の名前を出さない**(#722 P2-12)。
 *
 * > cowork の評価:追記の欄に `(Ctrl + Enter)` と出るが、スマホには Ctrl も
 * > Enter も無い ── **押せない物の名前が、欄の説明を半分埋めている**。
 *
 * ## ここで守るもの
 *
 * | 主張 | なぜ |
 * |---|---|
 * | 触るだけの端末では欄の字が「追記する内容」だけ | 押せない鍵の名前を出さない |
 * | ⚠ **対照群**: マウスの在る端末では今までどおり鍵が出る | 「いつでも消す」実装が上を満たして通るのを止める |
 * | ⚠ 片方だけ真の端末(マウス付きタブレット)では**消さない** | 消す向きの判定は狭く当てる(CLAUDE.md「誤差の向きを決める」) |
 * | `matchMedia` が無い器では出す | 分からないときは今までどおり(害の無い側) |
 *
 * ⚠ **鍵そのものは殺していない** ── ここが決めるのは字だけである。
 *   実際に `Ctrl+Enter` で送れることは `append-box.test.ts` が見ている。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOUCH_ONLY_QUERY,
  isTouchOnly,
} from '../../src/adapter/ui/render/touch-device';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';

/** `matchMedia` を差し替える。⚠ 問い合わせの綴りも記録する(何を聞いたかを見る)。 */
function stubMatchMedia(answer: (q: string) => boolean): { asked: string[] } {
  const asked: string[] = [];
  vi.stubGlobal('matchMedia', (q: string) => {
    asked.push(q);
    return { matches: answer(q) };
  });
  return { asked };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

describe('🔴 触るだけの端末かの判定は 1 か所(#722 P2-12)', () => {
  it('🔴 hover: none かつ pointer: coarse なら真', () => {
    const { asked } = stubMatchMedia(() => true);
    expect(isTouchOnly()).toBe(true);
    // ⚠ 空振り防止 ── 何も聞かずに真を返していない
    expect(asked, '問い合わせていない(判定が定数になっている)').toEqual([TOUCH_ONLY_QUERY]);
  });

  it('⚠ 対照群: マウスの在る端末では偽', () => {
    stubMatchMedia(() => false);
    expect(isTouchOnly()).toBe(false);
  });

  /**
   * 🔴 **片方だけ真の端末で消さない。**
   * ⚠ 綴りを `(hover: none)` だけに緩める変異は、ここでしか殺せない ──
   *   上の 2 件は「全部真 / 全部偽」なので、どちらの綴りでも同じ答えになる。
   */
  it('🔴 マウスを繋いだタブレット(hover は在る / 指も使える)では偽', () => {
    stubMatchMedia((q) => q.includes('pointer: coarse') && !q.includes('hover: none'));
    expect(isTouchOnly(), '片方だけ真の端末で鍵の字を消した').toBe(false);
  });

  it('⚠ matchMedia を持たない器では偽(分からないときは今までどおり)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isTouchOnly()).toBe(false);
  });
});

describe('🔴 追記の欄の字(#722 P2-12)', () => {
  const placeholder = (): string => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    new AppendBoxRenderer(regions.append);
    const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    expect(input, '追記の欄が無い(台の空振り)').not.toBeNull();
    return input!.placeholder;
  };

  it('🔴 触るだけの端末では、鍵の名前が出ない', () => {
    stubMatchMedia(() => true);
    const p = placeholder();
    expect(p, '押せない鍵の名前が欄に出ている').toBe('追記する内容');
  });

  /**
   * ⚠ **対照群** ── これが無いと「いつでも鍵を消す」実装が上を満たして通る。
   * 🔑 綴りは `chordLabel` が組むので、ここでは**括弧が付いたこと**だけを見る
   *   (mac では `⌘` になるため、字を丸ごと pin すると環境で割れる)。
   */
  it('⚠ 対照群: マウスの在る端末では、これまでどおり鍵が出る', () => {
    stubMatchMedia(() => false);
    const p = placeholder();
    expect(p.startsWith('追記する内容('), `鍵の名前が出ていない: ${p}`).toBe(true);
    expect(p, '鍵の名前が空の括弧になっている').not.toBe('追記する内容()');
  });
});
