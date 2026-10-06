/**
 * 🔴 **付箋の色(`fill=` / `stroke=`)と線の色・太さ(`stroke=` / `width=`)の綴りと書き込み**
 * (#530 段④。Gemini 裁定 A、2026-10-02)。
 *
 * 見るのは 3 つ:
 * - **読む規則**(`parsePlaceColor` / `parsePlaceWidth`)── 受けない値を**素通ししない**
 * - **書く規則**(`setPlaceStyle`)── 開き行の札だけを書き、**外せる**(片道にしない)
 * - **門** ── 開き行のずれ・fence の中・持てない札・読めない値では**書かない**
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isPlaceStyle,
  parsePlaceColor,
  parsePlaceWidth,
  PLACE_LINE_WIDTH_DEFAULT,
  placeInkOf,
} from '../../src/features/markdown/place-color';
import { placeLineMenuActions } from '../../src/features/entry-actions';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import {
  placeStyleAt,
  setPlaceStyle,
} from '../../src/features/markdown/place-notation';

describe('色の綴り(parsePlaceColor)', () => {
  it('🔴 #rgb / #rrggbb だけを受け、正規形(#rrggbb の小文字)へ揃える', () => {
    expect(parsePlaceColor('#ff8800')).toBe('#ff8800');
    expect(parsePlaceColor('#FF8800')).toBe('#ff8800');
    expect(parsePlaceColor('#f80')).toBe('#ff8800');
    expect(parsePlaceColor('  #0a0 ')).toBe('#00aa00');
  });

  it('🔴 受けない値は null(CSS・XML へ素通ししない)', () => {
    for (const bad of [
      'red',
      'javascript:alert(1)',
      'url(x)',
      '#ff88',
      '#ff880011',
      '#gg0000',
      'ff8800',
      '#ff8800;background:red',
      '#fff" onload="x',
      '',
      null,
      undefined,
      123,
      true,
    ]) {
      expect(parsePlaceColor(bad), `受けてはいけない値: ${String(bad)}`).toBeNull();
    }
  });
});

describe('太さの綴り(parsePlaceWidth)', () => {
  it('🔴 1〜16 の整数だけを受ける', () => {
    expect(parsePlaceWidth('1')).toBe(1);
    expect(parsePlaceWidth('4')).toBe(4);
    expect(parsePlaceWidth('16')).toBe(16);
    for (const bad of ['0', '17', '-1', '2.5', '4px', '', 'a', '099', null, undefined, 4]) {
      expect(parsePlaceWidth(bad), `受けてはいけない値: ${String(bad)}`).toBeNull();
    }
  });

  it('⚠ 標準の太さは CSS の既定と同じ数(同じ値を 2 か所に書いて片方だけ変えない)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    expect(css).toContain(`stroke-width: var(--pkc-line-width, ${PLACE_LINE_WIDTH_DEFAULT});`);
  });
});

describe('塗りの上の字の色(placeInkOf)', () => {
  it('🔴 明るい塗りには暗い字、暗い塗りには白い字(暗いテーマの明るい字が消えない)', () => {
    expect(placeInkOf('#ffe08a')).toBe('#1a1a1a');
    expect(placeInkOf('#ffffff')).toBe('#1a1a1a');
    expect(placeInkOf('#1e3a8a')).toBe('#ffffff');
    expect(placeInkOf('#000000')).toBe('#ffffff');
  });
});

/**
 * 🔴 **白黒の境目の両側**(着地後レビューの変異 D: `lum > 0.5` の境目が生き延びた)。
 * ⚠ 上の 4 色は**境目から遠い**(輝度 0.0 / 0.19 / 0.86 / 1.0)ので、境目を 0.4 や 0.6 へ動かしても緑だった。
 *   選んだのは**実際に輝度を計算した中間の色**(sRGB の係数 0.2126 / 0.7152 / 0.0722 ÷ 255):
 *   境目を上へ(0.55 以上)動かすと暗い側の 3 つが、下へ(0.45 以下)動かすと明るい側の 3 つが落ちる。
 */
describe('塗りの上の字の色(placeInkOf)── 境目の両側', () => {
  const lumOf = (c: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  // 輝度 0.5 より**わずかに下**〜0.41 ── 白い字
  const WHITE_INK = ['#7f7f7f', '#3b82f6', '#ef4444'];
  // 輝度 0.5 より**わずかに上**〜0.76 ── 暗い字
  const DARK_INK = ['#808080', '#22c55e', '#fbbf24'];

  it.each(WHITE_INK)('🔴 %s(輝度 0.5 の下)は白い字', (c) => {
    expect(lumOf(c), '前提が崩れた(この色が境目の下に無い)').toBeLessThan(0.5);
    expect(lumOf(c)).toBeGreaterThan(0.4);
    expect(placeInkOf(c)).toBe('#ffffff');
  });

  it.each(DARK_INK)('🔴 %s(輝度 0.5 の上)は暗い字', (c) => {
    expect(lumOf(c), '前提が崩れた(この色が境目の上に無い)').toBeGreaterThan(0.5);
    expect(lumOf(c)).toBeLessThan(0.8);
    expect(placeInkOf(c)).toBe('#1a1a1a');
  });

  it('🔴 読めない色は暗い字(地が無いのと同じ)', () => {
    expect(placeInkOf('red')).toBe('#1a1a1a');
  });
});

/**
 * 🔴 **線の太さが 1 のとき「線を細くする」は出ない**(着地後レビューの変異 F)。
 * ⚠ 押しても変わらない口を作らない。上の画面側の test は太さ `null` / 4 しか通らず、`1` を通らなかった。
 */
describe('線の右クリックの太さの口(placeLineMenuActions)', () => {
  const labelsAt = (width: number | null): string[] =>
    placeLineMenuActions({ stroke: false, width, widthWritten: width !== null }).map((a) => a.label);

  it('🔴 太さ 1 では「線を細くする」が出ない(対照:出るはずの 2 つの太さでは出る)', () => {
    expect(labelsAt(1), '押しても変わらない口が出た').not.toContain('線を細くする');
    expect(labelsAt(1)).toContain('線を太くする'); // 対照:消えたのは「細く」だけ
    expect(labelsAt(null)).toContain('線を細くする');
    expect(labelsAt(4)).toContain('線を細くする');
  });

  it('🔴 太さ 4 では「線を太くする」が出ない', () => {
    expect(labelsAt(4)).not.toContain('線を太くする');
    expect(labelsAt(1)).toContain('線を太くする');
  });
});

describe('isPlaceStyle(境界の検め)', () => {
  it('🔴 知らない札・読めない値・空は書いてよい物ではない', () => {
    expect(isPlaceStyle({ fill: '#ff0000' })).toBe(true);
    expect(isPlaceStyle({ fill: null })).toBe(true);
    expect(isPlaceStyle({ width: 4, stroke: '#00f' })).toBe(true);
    expect(isPlaceStyle({})).toBe(false);
    expect(isPlaceStyle({ fill: 'red' })).toBe(false);
    expect(isPlaceStyle({ fill: '#ff0000', color: '#000' })).toBe(false);
    expect(isPlaceStyle({ width: 99 })).toBe(false);
    expect(isPlaceStyle({ width: 2.5 })).toBe(false);
    expect(isPlaceStyle(null)).toBe(false);
  });
});

const BOARD_OPEN = ':::format{#a .pkc-place x=10 y=20 w=200 h=100}';
const LINE_OPEN = ':::format{.pkc-line from=a to=b}';
const BODY = `${BOARD_OPEN}\n中身\n:::\n\n:::format{#b .pkc-place x=300 y=20}\n:::\n\n${LINE_OPEN}\n:::\n`;
const target = (line: number, body = BODY) => ({ line, openLine: body.split('\n')[line]! });

describe('付箋の色を書く / 外す(setPlaceStyle)', () => {
  it('🔴 fill と stroke が開き行へ書かれ、他の札と本文は 1 byte も動かない', () => {
    const next = setPlaceStyle(BODY, target(0), { fill: '#ffe08a', stroke: '#B45309' })!;
    expect(next.split('\n')[0]).toBe(
      ':::format{#a .pkc-place x=10 y=20 w=200 h=100 fill=#ffe08a stroke=#b45309}',
    );
    // 開き行以外は同じ
    expect(next.split('\n').slice(1)).toEqual(BODY.split('\n').slice(1));
  });

  it('🔴 書き出しは正規形(3 桁は 6 桁へ・大文字は小文字へ)', () => {
    const next = setPlaceStyle(BODY, target(0), { fill: '#F80' })!;
    expect(next.split('\n')[0]).toContain('fill=#ff8800');
  });

  it('🔴 往復: 書いた色を placeStyleAt が同じ値で読む', () => {
    const next = setPlaceStyle(BODY, target(0), { fill: '#ffe08a', stroke: '#b45309' })!;
    expect(placeStyleAt(next.split('\n')[0]!)).toMatchObject({
      fill: '#ffe08a',
      stroke: '#b45309',
      width: null,
      any: true,
    });
    expect(placeStyleAt(BOARD_OPEN)).toMatchObject({ fill: null, stroke: null, any: false });
  });

  it('🔴 色なしにすると記法が消える(片道にしない)── 元の行へ 1 byte も違わず戻る', () => {
    const colored = setPlaceStyle(BODY, target(0), { fill: '#ffe08a', stroke: '#b45309' })!;
    const back = setPlaceStyle(colored, target(0, colored), { fill: null, stroke: null })!;
    expect(back).toBe(BODY);
  });

  it('🔴 札が元から無いものを消すときは body をそのまま返す(null = 断る、とは別)', () => {
    expect(setPlaceStyle(BODY, target(0), { fill: null })).toBe(BODY);
  });

  it('🔴 同じ札が重なっていたら 1 つにする(後ろが勝つ読み側でも見た目が変わる)', () => {
    const open = ':::format{#a .pkc-place fill=#111111 x=1 fill=#222222}';
    const body = `${open}\n:::\n`;
    const next = setPlaceStyle(body, { line: 0, openLine: open }, { fill: '#333333' })!;
    expect(next.split('\n')[0]!.match(/fill=/g)).toHaveLength(1);
    expect(placeStyleAt(next.split('\n')[0]!)!.fill).toBe('#333333');
    // 消すときも全部消える
    const gone = setPlaceStyle(body, { line: 0, openLine: open }, { fill: null })!;
    expect(gone.split('\n')[0]).toBe(':::format{#a .pkc-place x=1}');
  });

  it('🔴 引用符つきの手書きの値も置き換え・消去できる', () => {
    const open = ':::format{.pkc-place fill="#abcdef" x=1}';
    const body = `${open}\n:::\n`;
    const set = setPlaceStyle(body, { line: 0, openLine: open }, { fill: '#123456' })!;
    expect(set.split('\n')[0]).toBe(':::format{.pkc-place fill=#123456 x=1}');
    const gone = setPlaceStyle(body, { line: 0, openLine: open }, { fill: null })!;
    expect(gone.split('\n')[0]).toBe(':::format{.pkc-place x=1}');
  });

  it('🔴 括弧を持たない寛容形(`::: pkc-place`)は括弧つきへ整えて書く', () => {
    const open = '::: pkc-place';
    const body = `${open}\n:::\n`;
    const next = setPlaceStyle(body, { line: 0, openLine: open }, { fill: '#112233' })!;
    expect(next.split('\n')[0]).toBe('::: {.pkc-place fill=#112233}');
    // 消すだけなら行に触らない(消す物が無い)
    expect(setPlaceStyle(body, { line: 0, openLine: open }, { fill: null })).toBe(body);
  });
});

describe('線の色・太さを書く / 外す', () => {
  it('🔴 線の行には stroke と width が書かれる', () => {
    const next = setPlaceStyle(BODY, target(7), { stroke: '#2563eb', width: 4 })!;
    expect(next.split('\n')[7]).toBe(':::format{.pkc-line from=a to=b stroke=#2563eb width=4}');
    expect(placeStyleAt(next.split('\n')[7]!)).toMatchObject({
      stroke: '#2563eb',
      width: 4,
      fill: null,
    });
  });

  it('🔴 外せる ── 太さを標準へ戻す(width= を消す)/ 色を外す(stroke= を消す)', () => {
    const colored = setPlaceStyle(BODY, target(7), { stroke: '#2563eb', width: 4 })!;
    const noWidth = setPlaceStyle(colored, target(7, colored), { width: null })!;
    expect(noWidth.split('\n')[7]).toBe(':::format{.pkc-line from=a to=b stroke=#2563eb}');
    const back = setPlaceStyle(noWidth, target(7, noWidth), { stroke: null })!;
    expect(back).toBe(BODY);
  });

  it('🔴 持てない札は書かない ── 線に fill / 付箋に width', () => {
    expect(setPlaceStyle(BODY, target(7), { fill: '#ffffff' })).toBeNull();
    expect(setPlaceStyle(BODY, target(0), { width: 4 })).toBeNull();
    // 1 つでも持てない札が混じれば、持てる札も書かない(一部だけ書かない)
    expect(setPlaceStyle(BODY, target(0), { fill: '#ffffff', width: 4 })).toBeNull();
  });

  it('🔴 線の行のまま渡された付箋の札(stroke)は、線の色になる(押した種類へ書く)', () => {
    const next = setPlaceStyle(BODY, target(7), { stroke: '#112233' })!;
    expect(next.split('\n')[0]).toBe(BODY.split('\n')[0]); // 付箋の行は無傷
    expect(next.split('\n')[7]).toContain('stroke=#112233');
  });
});

describe('門(書いてはいけないとき)', () => {
  it('🔴 読めない値・知らない札は書かない', () => {
    expect(setPlaceStyle(BODY, target(0), { fill: 'javascript:alert(1)' })).toBeNull();
    expect(setPlaceStyle(BODY, target(0), { fill: 'red' })).toBeNull();
    expect(setPlaceStyle(BODY, target(7), { width: 99 })).toBeNull();
    expect(setPlaceStyle(BODY, target(0), {} as never)).toBeNull();
    expect(setPlaceStyle(BODY, target(0), { color: '#fff' } as never)).toBeNull();
  });

  it('🔴 開き行がずれていたら書かない(別の窓の書き込みで行が動いた形)', () => {
    expect(
      setPlaceStyle(BODY, { line: 0, openLine: ':::format{#a .pkc-place x=1 y=1}' }, { fill: '#ffffff' }),
    ).toBeNull();
    expect(setPlaceStyle(BODY, { line: 99, openLine: BOARD_OPEN }, { fill: '#ffffff' })).toBeNull();
  });

  it('🔴 板でも線でもない行(段落・別の塊)には書かない', () => {
    const body = `段落\n\n:::format{.highlight}\nx\n:::\n`;
    expect(setPlaceStyle(body, { line: 0, openLine: '段落' }, { fill: '#ffffff' })).toBeNull();
    expect(
      setPlaceStyle(body, { line: 2, openLine: ':::format{.highlight}' }, { fill: '#ffffff' }),
    ).toBeNull();
  });

  it('🔴 fence の中の板の字は書かない(コードの字)', () => {
    const body = `\`\`\`\n${BOARD_OPEN}\n:::\n\`\`\`\n`;
    expect(setPlaceStyle(body, { line: 1, openLine: BOARD_OPEN }, { fill: '#ffffff' })).toBeNull();
  });

  it('🔴 body-rewrite の入口(place-style)からも同じ結果が出る', () => {
    const next = applyBodyRewrite(BODY, {
      kind: 'place-style',
      line: 0,
      openLine: BOARD_OPEN,
      style: { fill: '#ffe08a' },
    });
    expect(next?.split('\n')[0]).toContain('fill=#ffe08a');
  });
});
