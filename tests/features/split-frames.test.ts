/**
 * `features/split-frames.ts`(#505 段②)。
 *
 * ⚠ **「規則を別の綴りで書き直す」test にしない**(CLAUDE.md 2026-08-22)──
 * 期待値は**実装と別の観測**から作る。ここでは「入れた物が出てくるか」
 * 「外した物が消えるか」「幅から出る枠数が単調か」を見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fittingSplitFrames,
  knownSplitLids,
  normalizeSplitLids,
  parseSplitLids,
  pinSplitLid,
  serializeSplitLids,
  SPLIT_FRAME_GAP_PX,
  SPLIT_PINNED_CHROME_PX,
  SPLIT_FRAME_MAX,
  SPLIT_PINNED_MAX,
  unpinSplitLid,
} from '@features/split-frames';
import {
  READ_COLUMN_BASE_FONT_PX,
  READ_COLUMN_GAP_PX,
  readColumnMinPx,
} from '@features/read-columns';

/** 本文の標準の大きさ(px)。⚠ **13 を書かない** ── 実装から引く(CLAUDE.md §7)。 */
const BASE = READ_COLUMN_BASE_FONT_PX;

describe('留める / 外す(双方向)', () => {
  it('留めた物は出てくる', () => {
    expect(pinSplitLid([], 'a')).toEqual(['a']);
  });

  it('🔴 外せる ── 置けるなら外せる(user 指示 2026-08-23)', () => {
    const pinned = pinSplitLid(pinSplitLid([], 'a'), 'b');
    expect(pinned).toEqual(['a', 'b']);
    expect(unpinSplitLid(pinned, 'a')).toEqual(['b']);
  });

  it('同じ物を 2 度留めても増えず、並びも動かない', () => {
    const cur = ['a', 'b'];
    expect(pinSplitLid(cur, 'a')).toBe(cur); // 参照ごと同じ = 指紋が動かない
  });

  it('⚠ 上限に達したら足さない(古い物を黙って落とさない)', () => {
    let cur: readonly string[] = [];
    for (let i = 0; i < SPLIT_PINNED_MAX; i += 1) cur = pinSplitLid(cur, `p${i}`);
    expect(cur).toHaveLength(SPLIT_PINNED_MAX);
    const after = pinSplitLid(cur, 'over');
    expect(after).toBe(cur);
    expect(after).not.toContain('over');
    // ⚠ 前提: 満杯だったこと(空振りで通っていない)
    expect(cur).toContain(`p${SPLIT_PINNED_MAX - 1}`);
  });

  it('居ない物を外しても、配列は同じ参照のまま', () => {
    const cur = ['a'];
    expect(unpinSplitLid(cur, 'zzz')).toBe(cur);
  });

  it('空文字は留まらない', () => {
    expect(pinSplitLid([], '')).toEqual([]);
    expect(normalizeSplitLids(['', 'a', ''])).toEqual(['a']);
  });

  it('重複は畳まれ、上限で切られる', () => {
    const many = Array.from({ length: SPLIT_PINNED_MAX + 5 }, (_, i) => `x${i}`);
    expect(normalizeSplitLids([...many, ...many])).toHaveLength(SPLIT_PINNED_MAX);
  });
});

describe('消えたノートを指し続けない', () => {
  it('知らない lid は出す前に落ちる', () => {
    expect(knownSplitLids(['a', 'gone'], new Set(['a']))).toEqual(['a']);
  });

  it('全部知っているなら同じ参照(描き直しを起こさない)', () => {
    const cur = ['a', 'b'];
    expect(knownSplitLids(cur, new Set(['a', 'b']))).toBe(cur);
  });

  it('Map でも引ける(entryMetas をそのまま渡せる)', () => {
    const metas = new Map([['a', { title: 'A' }]]);
    expect(knownSplitLids(['a', 'b'], metas)).toEqual(['a']);
  });
});

describe('狭い画面 ── 枠は「減る」。丸ごと 1 枠へ落ちない', () => {
  const min = readColumnMinPx(BASE);

  /**
   * n 枠を出すのに要る面の幅。
   *
   * ⚠ すき間だけでなく**留めた枠の飾り**も要る(#608)── 留めた枠は n − 1 枚あり、
   * `border-left` + `padding-left` を**中身の外**に持つ。
   * ⚠ **これは実装と同じ式である**(CLAUDE.md「別の綴りは同じ盲点を共有する」)──
   * だから境目の**振る舞い**だけを見て、飾りの値そのものは
   * 下の「CSS と突き合わせる」1 件と、実ブラウザの smoke が見る。
   */
  const needFor = (n: number, base = BASE): number =>
    readColumnMinPx(base) * n + (SPLIT_FRAME_GAP_PX + SPLIT_PINNED_CHROME_PX) * (n - 1);

  it('🔴 3 枠は入らないが 2 枠は入る幅では、2 枠になる', () => {
    const w = needFor(2); // ちょうど 2 枠
    // ⚠ 前提: 3 枠には足りないこと(空振り防止)
    expect(w).toBeLessThan(needFor(3));
    expect(fittingSplitFrames(w, 3, BASE)).toBe(2);
    // 🔴 **1px 足りなければ 1 枠**(境目が本当にここに在ることを見る)
    expect(fittingSplitFrames(w - 1, 3, BASE)).toBe(1);
  });

  it('2 枠にも足りなければ 1 枠', () => {
    expect(fittingSplitFrames(min * 2 - 1, 4, BASE)).toBe(1);
  });

  it('広ければ望んだ数がそのまま出る', () => {
    const w = needFor(SPLIT_FRAME_MAX);
    expect(fittingSplitFrames(w, SPLIT_FRAME_MAX, BASE)).toBe(SPLIT_FRAME_MAX);
  });

  it('⚠ 幅に対して単調 ── 広げて枠が減ることはない', () => {
    let prev = 1;
    for (let w = 100; w <= min * 5; w += 37) {
      const n = fittingSplitFrames(w, SPLIT_FRAME_MAX, BASE);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('🔴 文字を大きくすると、同じ幅で枠は減る(#509 と同じ向き)', () => {
    const w = needFor(3);
    expect(fittingSplitFrames(w, 3, BASE)).toBe(3);
    expect(fittingSplitFrames(w, 3, BASE * 1.4)).toBeLessThan(3);
  });

  it('測れない幅では 1 枠(0 を「入る」と読まない)', () => {
    expect(fittingSplitFrames(0, 3, BASE)).toBe(1);
    expect(fittingSplitFrames(Number.NaN, 3, BASE)).toBe(1);
  });

  it('上限を超える要求は上限で頭打ち', () => {
    expect(fittingSplitFrames(1e6, 99, BASE)).toBe(SPLIT_FRAME_MAX);
  });
});

describe('保存の往復', () => {
  it('書いて読むと同じ', () => {
    const cur = ['a', 'b'];
    expect(parseSplitLids(serializeSplitLids(cur))).toEqual(cur);
  });

  it('壊れていても例外を投げず、空になる', () => {
    expect(parseSplitLids(null)).toEqual([]);
    expect(parseSplitLids('')).toEqual([]);
    expect(parseSplitLids('   ')).toEqual([]);
  });
});

describe('すき間は段組みと同じ --s5(2 つ目の 16 を書かない)', () => {
  it('同じ値である', () => {
    expect(SPLIT_FRAME_GAP_PX).toBe(READ_COLUMN_GAP_PX);
  });
});

/**
 * 🔴 **CSS と TS のすき間・飾りを突き合わせる**(#608)。
 *
 * ⚠ #608 が名指しした**非対称**である ── 段組み側は
 * `tests/features/read-columns.test.ts` が `column-gap` を CSS から読んで
 * TS の定数と突き合わせているのに、**枠の側には 1 件も無かった**。
 * 🔑 判定は TS の定数で、見た目は CSS が決める ── 片方だけ動くと、
 * 「入る」と読んで**下限を割った枠**が並ぶ(2026-08-30 に実測で 7px 割っていた)。
 *
 * ⚠ **選択子は構文で拾う**(CLAUDE.md §1)── `indexOf(sel + ' {')` は
 * 選択子リスト(`A,\nB {`)を 1 つも拾えない。
 */
describe('CSS と突き合わせる(#608)', () => {
  const css = readFileSync('src/styles/app.css', 'utf-8');
  const tokens = readFileSync('src/styles/tokens.css', 'utf-8');

  /** `--sN` の実寸(px)。⚠ `rem` は root の 16px 基準。 */
  function token(name: string): number {
    const m = new RegExp(`${name}:\\s*([0-9.]+)rem`).exec(tokens);
    expect(m, `${name} が tokens.css に無い`).not.toBeNull();
    return Number.parseFloat(m![1]!) * 16;
  }

  /**
   * その選択子に当たる規則の本体。
   *
   * 🔴 **`@media` は「最初の 1 つで切る」ではなく、ブロックごと飛ばす**
   * (2026-08-30、書いていて踏んだ)。⚠ `read-columns.test.ts` は
   * `css.indexOf('@media')` で切っているが、それが効くのは**その規則が
   * 最初の `@media` より前に在る**からで、枠の規則は **5,199 行目**
   * (`@media` の後)に在るため **1 つも拾えなかった**。
   * ⚠ かといって `@media` の中まで拾うと、印刷や狭い版面だけの規則で
   * **画面の規則を消しても緑**になる(CLAUDE.md §1)。
   * 🔑 だから**入れ子を数えて、at-rule のブロックを丸ごと飛ばす**。
   */
  function ruleFor(selector: string): string {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    let found: string | null = null;
    while (i < body.length) {
      const open = body.indexOf('{', i);
      if (open === -1) break;
      const head = body.slice(i, open).trim();
      if (head.startsWith('@')) {
        // at-rule ── 中身は入れ子なので、対応する `}` まで飛ばす
        let depth = 1;
        let j = open + 1;
        for (; j < body.length && depth > 0; j += 1) {
          if (body[j] === '{') depth += 1;
          else if (body[j] === '}') depth -= 1;
        }
        i = j;
        continue;
      }
      const close = body.indexOf('}', open);
      if (close === -1) break;
      // ⚠ 選択子リストは `,` で割って**丸ごと一致**を見る(部分一致にしない)
      if (head.split(',').map((s) => s.trim()).includes(selector)) {
        found = body.slice(open + 1, close);
      }
      i = close + 1;
    }
    if (found === null) expect.fail(`選択子が見つからない: ${selector}`);
    return found;
  }

  it('🔴 枠のすき間(CSS の gap)が TS の定数と一致する', () => {
    const rule = ruleFor(
      "[data-pkc-view-pane='detail'][data-pkc-split='on'] [data-pkc-region='split-row']",
    );
    const gap = /(?:^|[\s;])gap:\s*var\(([^)]+)\)/.exec(rule);
    expect(gap, 'gap が var(--sN) で書かれていない').not.toBeNull();
    expect(token(gap![1]!.trim()), 'すき間が TS の定数とずれている').toBe(SPLIT_FRAME_GAP_PX);
  });

  it('🔴 留めた枠の飾り(border + padding)が TS の定数と一致する', () => {
    const rule = ruleFor(
      "[data-pkc-view-pane='detail'][data-pkc-split='on'] [data-pkc-split-lid]",
    );
    const border = /border-left:\s*([0-9.]+)px/.exec(rule);
    const pad = /padding-left:\s*var\(([^)]+)\)/.exec(rule);
    expect(border, 'border-left が px で書かれていない').not.toBeNull();
    expect(pad, 'padding-left が var(--sN) で書かれていない').not.toBeNull();
    expect(
      Number.parseFloat(border![1]!) + token(pad![1]!.trim()),
      '飾りの幅が TS の定数とずれている(判定より枠の中身が狭くなる)',
    ).toBe(SPLIT_PINNED_CHROME_PX);
  });
});
