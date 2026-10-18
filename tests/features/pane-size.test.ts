/**
 * ペインの大きさの**判定**(#497)。DOM も保存も出てこない ── ここは pure だけ。
 *
 * 🔴 守る主張:
 * 1. **向きが面ごとに違う**(右の面は左へ引くと広がる)── ここを取り違えると
 *    「掴んだ向きと逆に動く」という、触った瞬間に分かるのに test では見えない欠陥になる
 * 2. **下限を割ったら畳む**(0 の面を残さない)
 * 3. **掴みと鍵が同じ答えを出す**(§7 ── 判定が 2 か所に生えていない)
 * 4. 保存は**正規化**され、知らない値は捨てる
 */
import { describe, expect, it } from 'vitest';
import {
  decodePaneSizes,
  isPaneSizes,
  encodePaneSizes,
  nudgeOutcome,
  PANE_SIZE_SPECS,
  paneSizeCss,
  paneSizeVar,
  resizeOutcome,
  roundPaneSize,
  SIZED_PANES,
  type SizedPaneId,
} from '../../src/features/pane-size';

describe('向き(#497)', () => {
  /**
   * 🔴 **3 面を 1 つずつ名指しで見る。** ⚠ `PANE_SIZE_SPECS[id].grow` を使って
   * 期待値を組むと、**表を書き換えた変異がそのまま通る**(実装と同じ綴りの
   * 別の書き方になる ── CLAUDE.md §1「同じ盲点を共有する」)。
   */
  it('🔴 左の面は右へ引くと広がる', () => {
    expect(resizeOutcome('sidebar', 300, +40)).toEqual({ kind: 'size', px: 340 });
    expect(resizeOutcome('sidebar', 300, -40)).toEqual({ kind: 'size', px: 260 });
  });

  it('🔴 右の面は**左**へ引くと広がる', () => {
    expect(resizeOutcome('inspector', 300, -40)).toEqual({ kind: 'size', px: 340 });
    expect(resizeOutcome('inspector', 300, +40)).toEqual({ kind: 'size', px: 260 });
  });

  it('🔴 追記欄は**上**へ引くと高くなる', () => {
    expect(resizeOutcome('append', 100, -40)).toEqual({ kind: 'size', px: 140 });
    expect(resizeOutcome('append', 100, +40)).toEqual({ kind: 'size', px: 60 });
  });
});

describe('畳む・上限(#497)', () => {
  it('🔴 下限を割ったら「畳む」── 0 px の面を作らない', () => {
    for (const id of SIZED_PANES) {
      const min = PANE_SIZE_SPECS[id].min;
      // ⚠ 下限**ちょうど**は畳まない(境目をどちら側に置いたかを固定する)
      expect(resizeOutcome(id, min, 0), `${id}: 下限ちょうどで畳んだ`).toEqual({
        kind: 'size',
        px: min,
      });
      const outcome = resizeOutcome(id, min, PANE_SIZE_SPECS[id].grow * -1);
      expect(outcome, `${id}: 下限を割っても畳まない`).toEqual({ kind: 'collapse' });
    }
  });

  it('上限は超えない(引き続けても止まる)', () => {
    for (const id of SIZED_PANES) {
      const max = PANE_SIZE_SPECS[id].max;
      const outcome = resizeOutcome(id, max, PANE_SIZE_SPECS[id].grow * 10_000);
      expect(outcome, `${id}: 上限を超えた`).toEqual({ kind: 'size', px: max });
    }
  });

  /**
   * 🔴 **掴みと鍵が同じ答えを出す**(§7)。⚠ 別々に書くと、
   * 「鍵でだけ畳めない」「鍵でだけ上限が違う」が静かに生まれる。
   */
  it('🔴 鍵 1 回は「1 step ぶん掴んだ」と同じ', () => {
    for (const id of SIZED_PANES) {
      const step = PANE_SIZE_SPECS[id].step;
      expect(nudgeOutcome(id, 300, +1), id).toEqual(resizeOutcome(id, 300, +step));
      expect(nudgeOutcome(id, 300, -1), id).toEqual(resizeOutcome(id, 300, -step));
    }
  });

  it('🔴 畳んである面(0)から引き出せる ── 戻す口が 2 本ある', () => {
    // ⚠ 下限まで引かないと戻らない(中途半端に細い面を作らない)
    expect(resizeOutcome('sidebar', 0, +40)).toEqual({ kind: 'collapse' });
    expect(resizeOutcome('sidebar', 0, +200)).toEqual({ kind: 'size', px: 200 });
  });
});

describe('保存の形(#497)', () => {
  it('触っていない面は書かない', () => {
    expect(encodePaneSizes({})).toBe('');
    expect(encodePaneSizes({ inspector: 300 })).toBe('inspector:300');
  });

  it('🔴 並びは正規化する(同じ状態が 2 通りの文字列にならない)', () => {
    expect(encodePaneSizes({ inspector: 300, sidebar: 240 })).toBe(
      encodePaneSizes({ sidebar: 240, inspector: 300 }),
    );
  });

  it('往復して変わらない', () => {
    const sizes = { sidebar: 240, inspector: 300, append: 120 };
    expect(decodePaneSizes(encodePaneSizes(sizes))).toEqual(sizes);
  });

  it('知らない名前・数でない値・0 以下は捨てる', () => {
    expect(decodePaneSizes('sidebar:240 ghost:99 inspector:abc append:0 append:-5')).toEqual({
      sidebar: 240,
    });
    expect(decodePaneSizes('')).toEqual({});
    expect(decodePaneSizes(null)).toEqual({});
    expect(decodePaneSizes('sidebar')).toEqual({});
  });

  it('🔴 下限を割った保存は捨てる(5px の左の列・0px の右の列にならない)・下限ちょうどは受ける(#1087 D7)', () => {
    for (const id of SIZED_PANES) {
      const min = PANE_SIZE_SPECS[id].min;
      expect(decodePaneSizes(`${id}:${min - 1}`), `${id}: 下限未満を受けている`).toEqual({});
      expect(decodePaneSizes(`${id}:${min}`), `${id}: 下限ちょうどを捨てている`).toEqual({ [id]: min });
      expect(isPaneSizes(`${id}:${min - 1}`), `${id}: 設定ファイルの下見が下限未満を通す`).toBe(false);
      expect(isPaneSizes(`${id}:${min}`)).toBe(true);
    }
    expect(decodePaneSizes('sidebar:5')).toEqual({});
    expect(decodePaneSizes('inspector:0.4')).toEqual({});
    // 対照群: 1 面が下限未満でも、ほかの面は生きる
    expect(decodePaneSizes('sidebar:5 inspector:300')).toEqual({ inspector: 300 });
  });

  it('上限を超えた保存は丸める(手で書き換えた file でも壊れない)', () => {
    expect(decodePaneSizes('sidebar:99999')).toEqual({ sidebar: PANE_SIZE_SPECS.sidebar.max });
    expect(roundPaneSize('sidebar', Number.NaN)).toBe(0);
  });
});

describe('CSS へ渡す形(#497)', () => {
  /**
   * 🔴 **画面が狭くなったら自分で縮む** ── これが無いと、決めた幅のせいで
   * 本文が消えるところまで押し出される(そして user は直し方が分からない)。
   * ⚠ 上限が `vw` / `vh` で入っていることまで見る ── px だけだと縮まない。
   */
  it('🔴 clamp で自分を制限する(JS が resize を聞き直さなくてよい)', () => {
    expect(paneSizeCss('sidebar', 240)).toBe('clamp(0px, 240px, min(45vw, max(240px, calc((100vw - 500px) / 2))))');
    expect(paneSizeCss('inspector', 300)).toBe('clamp(0px, 300px, min(45vw, max(240px, calc((100vw - 500px) / 2))))');
    // ⚠ 高さの面は **vh** ── vw を使い回すと、横長の画面で青天井になる
    expect(paneSizeCss('append', 120)).toBe('clamp(0px, 120px, 60vh)');
  });

  /**
   * 🔴 **左右を最大まで広げても、幅 1100px 以上の画面では本文に 480px 残る**(台帳 #1852 束 S1、依頼 350 A)。
   * ⚠ 文字列の一致だけでは「式が正しいか」を言えない ── 実際に **CSS の式を評価**して、本文の幅を出す
   *   (期待値を実装の定数から組まない: 左右の掴む帯 8px×2 と隙間 1px×4 は `app.css` の枠の値)。
   * ⚠ 覚えた幅(`sidebar:640` など)そのものは書き換えない ── 上限は表示のときだけ効く。
   */
  it('🔴 左右とも最大(640px)でも、幅 1100〜2560px の画面で本文が 480px を割らない', () => {
    // `paneSizeCss` が返す clamp の第 3 引数(上限)を取り出し、vw ごとに評価する
    const css = paneSizeCss('sidebar', 640);
    const m = /^clamp\(0px, 640px, (.+)\)$/.exec(css);
    expect(m, '上限の式が読めない(形が変わった)').not.toBeNull();
    const evaluate = (expr: string, vw: number): number => {
      const e = expr
        .replace(/calc\(/g, '(')
        .replace(/(\d+(?:\.\d+)?)vw/g, (_s, n: string) => `(${n}*${String(vw)}/100)`)
        .replace(/(\d+(?:\.\d+)?)px/g, '$1')
        .replace(/\bmin\(/g, 'Math.min(')
        .replace(/\bmax\(/g, 'Math.max(');
      return new Function(`return (${e});`)() as number;
    };
    let minCenter = Infinity;
    for (const vw of [1100, 1200, 1280, 1366, 1400, 1440, 1600, 1920, 2560]) {
      const cap = evaluate(m![1]!, vw);
      const side = Math.min(640, cap); // 左右それぞれ、覚えた 640px か上限の小さいほう
      const center = vw - 2 * side - 16 - 4; // 掴む帯 8px×2 + 隙間 1px×4
      minCenter = Math.min(minCenter, center);
      expect(center, `幅 ${String(vw)}px で本文が ${String(center)}px しか残らない`).toBeGreaterThanOrEqual(480);
    }
    // 空振り防止: 上限が効いていない(= 全部 640px のまま)なら、1100px で本文は 1100-1280-20 < 0 になる ── 式を見ている
    expect(evaluate(m![1]!, 1100), '式が上限になっていない').toBeLessThan(640);
    expect(minCenter).toBeGreaterThanOrEqual(480);
  });

  it('対照群: 広い画面(2560px)では覚えた幅の 640px がそのまま効く(広げた幅を勝手に縮めない)', () => {
    const m = /^clamp\(0px, 640px, (.+)\)$/.exec(paneSizeCss('sidebar', 640))!;
    const e = m[1]!
      .replace(/calc\(/g, '(')
      .replace(/(\d+(?:\.\d+)?)vw/g, (_s, n: string) => `(${n}*2560/100)`)
      .replace(/(\d+(?:\.\d+)?)px/g, '$1')
      .replace(/\bmin\(/g, 'Math.min(')
      .replace(/\bmax\(/g, 'Math.max(');
    expect(new Function(`return (${e});`)() as number).toBeGreaterThanOrEqual(640);
  });

  it('変数名は 1 か所で綴る', () => {
    for (const id of SIZED_PANES) expect(paneSizeVar(id)).toBe(`--pkc-pane-${id}`);
  });

  /**
   * 🔴 **CSS 側にも同じ変数が在る**(§7 の「両端が別々に綴る」)。
   * ⚠ 片方の綴りを変えても、どちらの test も緑のまま通る ── だから
   *   **実物の CSS を読んで**突き合わせる。
   */
  it('🔴 app.css が同じ名前を読んでいる', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf-8');
    for (const id of SIZED_PANES as readonly SizedPaneId[]) {
      expect(css, `${id}: CSS が ${paneSizeVar(id)} を読んでいない`).toContain(
        `var(${paneSizeVar(id)},`,
      );
    }
  });
});
