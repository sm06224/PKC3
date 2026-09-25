/**
 * 🔴 **窓を広げたのに、左の列が縮まない**(C16 / #1045)。
 *
 * 直す前(main `fdc3ee6` を本物の build で実測):
 *
 * | 窓の幅 | 左の列 | 「+ ノート」の列 |
 * |---|---|---|
 * | 1100 | 242px(`@media (max-width: 1100px)` の `22vw`) | 2 段 |
 * | 1101 | **200px**(1101px からの版面の下限) | **3 段** |
 * | 1248 | 224.6px | 3 段 |
 * | 1249 | 224.8px | 2 段 |
 *
 * ⚠ 1px 広げた瞬間に左の列が 42px 縮み、1248px まで折れたままだった。
 * 🔑 直し方は「1101px からの下限 = 境目の下側の幅」── 2 つの数を**結んで**見る。
 *   片方だけ動かす(境目を 1024 にする / 22vw を 20vw にする)と、また境目で縮む。
 *
 * ⚠ happy-dom は描画しないので、原文を**構文で**読む(`tests/helpers/css-blocks.ts`)。
 *   描いた幅は `tests/smoke` が見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blocksFor, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';
import { TABLET_MAX_PX } from '../../src/features/phone-layout';

const css = stripComments(readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf8'));

/** 左の列の既定の幅 `var(--pkc-pane-sidebar, minmax(<px>px, <vw>vw))` を読む。 */
function sidebarOf(decls: string): { px: number; vw: number } | null {
  const m = /grid-template-columns:\s*var\(--pkc-pane-sidebar,\s*minmax\((\d+(?:\.\d+)?)px,\s*(\d+(?:\.\d+)?)vw\)\)/.exec(
    decls,
  );
  return m ? { px: Number(m[1]), vw: Number(m[2]) } : null;
}

function sidebarsFor(src: string, sel: string): { px: number; vw: number }[] {
  return blocksFor(src, sel)
    .map(sidebarOf)
    .filter((x): x is { px: number; vw: number } => x !== null);
}

/** `minmax(px, vw)` が窓の幅 w で取る幅(`vw` が下限を割れば下限)。 */
const widthAt = (s: { px: number; vw: number }, w: number): number => Math.max(s.px, (w * s.vw) / 100);

const desktop = sidebarsFor(withoutMedia(css), "[data-pkc-region='shell']");
const desktopNoInspector = sidebarsFor(
  withoutMedia(css),
  "[data-pkc-region='shell'][data-pkc-hidden-panes~='inspector']",
);
const tablet = sidebarsFor(mediaBlock(css, `(max-width: ${TABLET_MAX_PX}px)`).body, "[data-pkc-region='shell']");

describe('🔴 1100px の境目で、左の列が縮まない(C16)', () => {
  it('空振り防止 ── 3 つの版面から左の列の幅を読めている', () => {
    expect(desktop, '1101px からの版面の左の列が読めない').toHaveLength(1);
    expect(desktopNoInspector, '右を畳んだ版面の左の列が読めない').toHaveLength(1);
    expect(tablet, `${TABLET_MAX_PX}px 以下の版面の左の列が読めない`).toHaveLength(1);
  });

  it('境目の 1px 上の幅は、境目の幅より狭くない(右を出しているときも、畳んだときも)', () => {
    const below = widthAt(tablet[0]!, TABLET_MAX_PX);
    for (const [name, s] of [
      ['右を出している版面', desktop[0]!],
      ['右を畳んだ版面', desktopNoInspector[0]!],
    ] as const) {
      expect(
        widthAt(s, TABLET_MAX_PX + 1),
        `${name}: ${TABLET_MAX_PX + 1}px で左の列が ${widthAt(s, TABLET_MAX_PX + 1)}px に縮む(境目の下は ${below}px)`,
      ).toBeGreaterThanOrEqual(below);
    }
  });

  it('境目より上では、窓を広げても左の列は縮まない(1101〜2560px を 1px ずつ)', () => {
    for (const s of [desktop[0]!, desktopNoInspector[0]!]) {
      let prev = widthAt(s, TABLET_MAX_PX + 1);
      for (let w = TABLET_MAX_PX + 2; w <= 2560; w++) {
        const now = widthAt(s, w);
        expect(now, `${w}px で左の列が縮んだ`).toBeGreaterThanOrEqual(prev);
        prev = now;
      }
    }
  });

  it('⚠ 対照群 ── 下限を上げすぎていない(1366px では 18vw のほうが効く = 直す前と同じ幅)', () => {
    expect(widthAt(desktop[0]!, 1366)).toBeCloseTo((1366 * desktop[0]!.vw) / 100, 5);
  });
});
