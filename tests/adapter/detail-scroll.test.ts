/** @vitest-environment happy-dom */
/**
 * P8 段⑪: **描き直しでスクロールを殺さない**。
 *
 * > user 指示 2026-08-03「**レンダリングした後にスクロールがトップに戻る
 * > no-op も塞いでね**」
 *
 * 実機の観測は `tests/smoke/format-bar.smoke.spec.ts`。ここが見るのは
 * **実機では作れない窓** ── 「編集に入ったまま別のノートを開く」。
 */
import { describe, expect, it } from 'vitest';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** `[data-pkc-region="detail"]`(スクロールする器)の中に pane を置く実構造。 */
function setup() {
  const scroller = document.createElement('div');
  scroller.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  scroller.append(pane);
  document.body.append(scroller);
  return { scroller, r: new DetailRenderer(pane) };
}

function state(lid: string, body: string, phase: AppState['phase'] = 'ready'): AppState {
  return {
    ...initialState,
    phase,
    selectedLid: lid,
    entryMetas: new Map([
      ['a', meta('a')],
      ['b', meta('b')],
    ]),
    openBody: { lid, body, baseline: body, persisted: body, diskAhead: false },
  };
}

const LONG = Array.from({ length: 40 }, (_, i) => `## 節 ${i}\n\n段落 ${i}。\n`).join('\n');

/**
 * 🔴 **読む面はワーカーで描く**(2026-08-06。user 報告 2-8)ので、位置戻しは
 * `render()` の**中では起きない** ── 本文が入った後(結果が返った後)に走る。
 * ⚠ ここを待たないと、この file の test は**全部空振りする**:
 * `render()` 直後に `scrollTop` を代入して同期に assert すると、
 * 位置戻しが一度も走らないまま「動いていない」を見て緑になる
 * (実際に 1 件がそうなっていた)。
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('本文ペインのスクロール', () => {
  it('🔴 同じノートの本文が変わっても位置を動かさない', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('a', `${LONG}\n\n足した段落。\n`));
    await settle();
    expect(scroller.scrollTop, '描き直しで先頭へ飛んだ').toBe(500);
  });

  it('別のノートを開いたら先頭から', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('b', LONG));
    await settle();
    expect(scroller.scrollTop).toBe(0);
  });

  it('編集して戻ってきたら元の位置へ', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('a', LONG, 'editing'));
    await settle();
    scroller.scrollTop = 0; // 編集の面は別物(先頭から始まる)
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '保存で戻ったら先頭へ飛んだ').toBe(500);
  });

  it('🔴 編集に入ったまま**別のノート**を開いたら、覚えた位置を持ち込まない', async () => {
    // ⚠ ここは実機では作れない窓(編集中に一覧を押しても切り替わらない)。
    // 持ち込むと「B を途中から見せる」になる ── 変異試験で素通りしていた経路
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('a', LONG, 'editing'));
    await settle();
    scroller.scrollTop = 0;
    r.render(state('b', LONG));
    await settle();
    expect(scroller.scrollTop, '別のノートに前のノートの位置を持ち込んだ').toBe(0);
  });
});

/**
 * #690 ①: **ノートごとに読んでいた場所を憶える**(user 裁定 2026-09-04、案 A)。
 *
 * 直す前は「編集へ入る直前」しか憶えておらず、A を中ほどまで読んで B を選び
 * A へ戻ると**必ず先頭**だった。
 * ⚠ happy-dom の `scrollTop` は**素の数値**(丸めも NaN の拒否も無い)── だから
 *   「NaN / 負を書かない」はここで**そのまま観測できる**(本物は拒むので見えない)。
 * ⚠ 指紋の罠(CLAUDE.md §2)── 戻りは `selectedLid` が変わるので必ず `renderView` に
 *   入る。同じ lid で `render()` を 2 度呼ぶ形は書かない(早期 return で空振りする)。
 */
describe('ノートごとに読んでいた場所を憶える (#690 ①)', () => {
  /** 何も選んでいない状態(中央は案内文だけ)。 */
  function none(): AppState {
    return {
      ...initialState,
      phase: 'ready',
      selectedLid: null,
      entryMetas: new Map([
        ['a', meta('a')],
        ['b', meta('b')],
      ]),
      openBody: null,
    };
  }

  it('🔴 別のノートを見てから戻ると、読んでいた場所から出る', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('b', LONG));
    await settle();
    // ⚠ 対照群 ── 初めて開くノートは先頭から(A の位置を持ち込まない)
    expect(scroller.scrollTop, '初めてのノートが先頭から始まらない').toBe(0);
    scroller.scrollTop = 300;
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, 'A へ戻ったのに読んでいた場所へ戻らない').toBe(500);
    // 🔑 B の位置も別に憶えている(1 つの値を使い回していない)
    r.render(state('b', LONG));
    await settle();
    expect(scroller.scrollTop, 'B の位置が A の位置に上書きされた').toBe(300);
  });

  it('🔴 憶え直しが効く(最初の値に固定されない)', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('b', LONG));
    await settle();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 900;
    r.render(state('b', LONG));
    await settle();
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '2 巡目の位置ではなく 1 巡目の位置に戻った').toBe(900);
  });

  it('横の送り(段組み)も一緒に憶える', async () => {
    const { scroller, r } = setup();
    // ⚠ `setup()` は器を document へ足し続けるので、**この test の器の中**で探す
    //    (document 全体で探すと前の test の器に当たる ── §1「別の面の文字」の型)
    const host = (): HTMLElement =>
      scroller.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    r.render(state('a', LONG));
    await settle();
    expect(host(), '前提が崩れた(本文の器が無い)').not.toBeNull();
    scroller.scrollTop = 500;
    host().scrollLeft = 120;
    r.render(state('b', LONG));
    await settle();
    expect(host().scrollLeft, '初めてのノートに横の位置を持ち込んだ').toBe(0);
    r.render(state('a', LONG));
    await settle();
    expect(host().scrollLeft, '横の送りが戻らない(#505 の縦だけ版)').toBe(120);
    expect(scroller.scrollTop).toBe(500);
  });

  it('🔴 編集に入ったまま別のノートを開いても、元のノートへ戻れば読んでいた場所', async () => {
    // ⚠ `parkedScroll` は B を描いた時点で捨てられる ── ここで A の位置が
    //    出るのは lid ごとの器のほう(編集へ入る直前の値も器へ入れている)
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('a', LONG, 'editing'));
    await settle();
    scroller.scrollTop = 0;
    r.render(state('b', LONG));
    await settle();
    expect(scroller.scrollTop, '対照群: B は先頭から').toBe(0);
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '編集を挟んだら A の位置を忘れた').toBe(500);
  });

  it('編集から戻る既存の経路は今までどおり(器が無くても効く)', async () => {
    // ⚠ 対照群 ── `parkedScroll` の経路を lid ごとの器で置き換えていない。
    //    編集中に送った値は器に入らない(読む面ではない)ので、戻りは parked の値
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(state('a', LONG, 'editing'));
    await settle();
    scroller.scrollTop = 7;
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '編集の面の位置を持ち込んだ').toBe(500);
  });

  it('何も選ばない状態を挟んでも、戻れば読んでいた場所', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    r.render(none());
    await settle();
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '選択を外して戻ると先頭へ飛ぶ').toBe(500);
  });

  it('🔴 NaN や負の値は憶えない(戻すときは 0)', async () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    (scroller as { scrollTop: number }).scrollTop = Number.NaN;
    r.render(state('b', LONG));
    await settle();
    r.render(state('a', LONG));
    await settle();
    expect(Number.isNaN(scroller.scrollTop), 'NaN をそのまま書いた').toBe(false);
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = -40;
    r.render(state('b', LONG));
    await settle();
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '負の値をそのまま書いた').toBe(0);
  });

  it('🔴 憶えるのは 200 件まで ── 古いものから忘れる', async () => {
    // ⚠ 境界を両側から見る(199 件なら残り、200 件なら消える)── 片側だけだと
    //    「上限そのものを外す」変異が素通りする
    const run = async (others: number): Promise<number> => {
      const { scroller, r } = setup();
      r.render(state('a', LONG));
      await settle();
      scroller.scrollTop = 500;
      for (let i = 0; i < others; i++) {
        r.render(state(`n${i}`, 'x'));
        await settle();
      }
      r.render(state('a', LONG));
      await settle();
      const top = scroller.scrollTop;
      scroller.remove();
      return top;
    };
    expect(await run(199), '上限の内側なのに忘れた').toBe(500);
    expect(await run(200), '上限を超えても忘れない(器が伸び続ける)').toBe(0);
  });

  it('🔴 忘れるのは「最後に見た順」で古いもの(見直したノートは若返る)', async () => {
    // ⚠ Map の挿入順をそのまま使うと、A を見直しても A が最古のまま消える ──
    //    上の test では見えない(A を 1 度しか見ていない)ので、ここで別に見る
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    for (let i = 0; i < 199; i++) {
      r.render(state(`n${i}`, 'x'));
      await settle();
    }
    r.render(state('a', LONG)); // 器は満杯(A + 199 件)。A を見直す
    await settle();
    expect(scroller.scrollTop, '前提が崩れた(満杯の時点で A を忘れている)').toBe(500);
    r.render(state('n199', 'x')); // ここで 1 件あふれる ── 消えるのは n0 であって A ではない
    await settle();
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '見直したばかりの A を忘れた(挿入順のまま消している)').toBe(500);
  });

  it('🔴 憶えるのは器を空にする**前**(後だと 0 に丸められた値を憶える)', async () => {
    // ⚠ 本物の `scrollTop` は中身より下を指せない ── happy-dom は素通しなので、
    //    ここだけ丸めを真似る(`scroll-memory.test.ts` と同じ作法)。順番を逆に
    //    しても素の器では緑のまま(変異試験 M9 が SURVIVED で教えた)
    const { scroller, r } = setup();
    const pane = scroller.firstElementChild as HTMLElement;
    // ⚠ 丸めは**読むときにも**効く(中身を空にした瞬間 0 になり、戻らない)──
    //    書くときだけ丸めると、空にした後に読んでも 500 が返って順番の違いが写らない
    let top = 0;
    const clamp = (): number => (pane.childElementCount > 0 ? top : (top = 0));
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => clamp(),
      set: (v: number) => {
        top = v;
        clamp();
      },
      configurable: true,
    });
    r.render(state('a', LONG));
    await settle();
    scroller.scrollTop = 500;
    expect(scroller.scrollTop, '前提が崩れた(中身が在るのに丸めた)').toBe(500);
    r.render(state('b', LONG));
    await settle();
    r.render(state('a', LONG));
    await settle();
    expect(scroller.scrollTop, '器を空にした後の値(0)を憶えた').toBe(500);
  });
});
