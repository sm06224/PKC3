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

/**
 * 🔴 **端末を模した `matchMedia`**(2026-09-05、変異試験 M6 が SURVIVED で教えた)。
 *
 * ⚠ 1 稿目は「問い合わせの綴りを見て真偽を返す」形だった ── **綴りを変える変異と
 *   同じ盲点を共有する**ので、`(hover: none) and (pointer: coarse)` を
 *   `(hover: none)` へ**緩める変異が生き延びた**(台のほうも綴りを見て
 *   答えを変えてしまうため、どちらの実装でも同じ答えになる)。
 * 🔑 だから台は**端末の性質**を持ち、問い合わせを**その性質に照らして評価する** ──
 *   実物の `matchMedia` と同じ意味論にする(CLAUDE.md §3「stub は本物の意味論を真似る」)。
 */
type Device = { hover: 'none' | 'hover'; pointer: 'coarse' | 'fine' };

function stubDevice(dev: Device): { asked: string[] } {
  const asked: string[] = [];
  vi.stubGlobal('matchMedia', (q: string) => {
    asked.push(q);
    // ⚠ `(a: b)` を全部拾い、**知らない特性が来たら落とす**(黙って真にしない)
    const feats = [...q.matchAll(/\(\s*([\w-]+)\s*:\s*([\w-]+)\s*\)/g)];
    if (feats.length === 0) throw new Error(`台が読めない問い合わせ: ${q}`);
    const matches = feats.every(([, name, value]) => {
      if (name === 'hover') return dev.hover === value;
      if (name === 'pointer') return dev.pointer === value;
      throw new Error(`台が知らない特性: ${name}`);
    });
    return { matches };
  });
  return { asked };
}

/** よく出す 4 通り。⚠ **4 つとも実在する形**である(下の注記)。 */
const PHONE: Device = { hover: 'none', pointer: 'coarse' };
const MOUSE: Device = { hover: 'hover', pointer: 'fine' };
/** マウスを繋いだタブレット ── 指も使えるが、乗せることもできる。 */
const TABLET_WITH_MOUSE: Device = { hover: 'hover', pointer: 'coarse' };
/** ペンで指す端末 ── 乗せられないが、指す先は細かい。 */
const STYLUS: Device = { hover: 'none', pointer: 'fine' };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

describe('🔴 触るだけの端末かの判定は 1 か所(#722 P2-12)', () => {
  it('🔴 スマホ(乗せられない / 指で触る)では真', () => {
    const { asked } = stubDevice(PHONE);
    expect(isTouchOnly()).toBe(true);
    // ⚠ 空振り防止 ── 何も聞かずに真を返していない
    expect(asked, '問い合わせていない(判定が定数になっている)').toEqual([TOUCH_ONLY_QUERY]);
  });

  it('⚠ 対照群: マウスの端末では偽', () => {
    stubDevice(MOUSE);
    expect(isTouchOnly()).toBe(false);
  });

  /**
   * 🔴 **片方だけ真の端末で消さない。** ⚠ 2 通りとも要る ──
   *   片方しか置かないと、綴りを**もう一方だけ**に緩める変異が生き延びる
   *   (実際 M6「`(hover: none)` だけにする」は、タブレットの腕だけでは
   *   **殺せなかった**。1 稿目の台が綴りを見て答えていたのも同じ盲点)。
   */
  it('🔴 マウスを繋いだタブレット(乗せられる / 指も使える)では偽', () => {
    stubDevice(TABLET_WITH_MOUSE);
    expect(isTouchOnly(), 'pointer だけで切ったので、乗せられる端末で字を消した').toBe(false);
  });

  it('🔴 ペンで指す端末(乗せられない / 指す先は細かい)では偽', () => {
    stubDevice(STYLUS);
    expect(isTouchOnly(), 'hover だけで切ったので、鍵の在る端末で字を消した').toBe(false);
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
    stubDevice(PHONE);
    const p = placeholder();
    expect(p, '押せない鍵の名前が欄に出ている').toBe('追記する内容');
  });

  /**
   * ⚠ **対照群** ── これが無いと「いつでも鍵を消す」実装が上を満たして通る。
   * 🔑 綴りは `chordLabel` が組むので、ここでは**括弧が付いたこと**だけを見る
   *   (mac では `⌘` になるため、字を丸ごと pin すると環境で割れる)。
   */
  it('⚠ 対照群: マウスの在る端末では、これまでどおり鍵が出る', () => {
    stubDevice(MOUSE);
    const p = placeholder();
    expect(p.startsWith('追記する内容('), `鍵の名前が出ていない: ${p}`).toBe(true);
    expect(p, '鍵の名前が空の括弧になっている').not.toBe('追記する内容()');
  });
});
