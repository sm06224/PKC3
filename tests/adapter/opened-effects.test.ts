/** @vitest-environment happy-dom */
/**
 * 🔴 **「最近開いた」を憶える配線**(#215 残り①)。
 *
 * ⚠ 規則(`opened-log`)と置き場(`opened-store`)は別の test が見る ──
 *   ここで見るのは**その間**、つまり「開いたら憶えるか / 画面に載るか」である
 *   (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectOpenedEffects } from '../../src/adapter/platform/opened-effects';
import {
  appOpenedStore,
  OpenedStore,
  type OpenedStorage,
} from '../../src/adapter/platform/opened-store';
import { readFileSync } from 'node:fs';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  } as EntryMeta;
}

function fake(initial: string | null = null): OpenedStorage {
  let value = initial;
  return {
    get: () => value,
    set: (_k, v) => {
      value = v;
    },
    remove: () => {
      value = null;
    },
  };
}

function setup(initial: string | null = null) {
  const d = new Dispatcher();
  const store = new OpenedStore(fake(initial));
  let clock = 1000;
  const off = connectOpenedEffects(d, store, () => (clock += 10));
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', 1), meta('n2', 2)],
    relations: [],
  });
  return { d, store, off };
}

describe('最近開いたを憶える配線(#215 残り①)', () => {
  it('🔴 開くと憶え、state にも載る(並べ替えが引ける形で)', () => {
    const { d, store, off } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(store.map().has('n1'), '保存に憶えていない').toBe(true);
    expect(d.getState().openedAt.get('n1'), 'state に載っていない(並べ替えが引けない)').toBe(
      store.map().get('n1'),
    );
    off();
  });

  /**
   * ⚠ **同じノートを見続けている間は書かない** ── 描画のたびに書くと、
   *   localStorage を毎回触ることになる。
   */
  it('🔴 同じノートのままなら、2 度目は書かない', () => {
    const { d, store, off } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const first = store.map().get('n1');
    // 別のことを起こして state を動かす(選択は変えない)
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'あ' });
    expect(store.map().get('n1'), '同じノートのままなのに時刻が動いた').toBe(first);
    off();
  });

  /**
   * 🔴 **知らない lid は憶えない** ── 消したノートの残骸を憶えると、
   *   並べ替えの先頭が「開けないノート」になる。
   *
   * ⚠ **ここが見ているのは上流の保証である**(2026-09-11 の変異試験で判明)──
   *   `SELECT_ENTRY` の側が「一覧に無い lid は選ばない」を既に持つので、
   *   配線側の門を外しても**この it は緑のまま**である。
   * 🔑 それでも残す:壊れたら困るのは**上流のほう**で、そこが緩んだ日に
   *   ここが鳴る(配線の門は、書く直前のもう 1 枚として置いてあるだけ)。
   */
  it('🔴 一覧に無い lid は憶えない(上流の SELECT_ENTRY が断っている)', () => {
    const { d, store, off } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'ghost' });
    expect(store.map().has('ghost'), '知らない lid を憶えた').toBe(false);
    off();
  });

  /**
   * 🔴 **消えたノートの記録は、起動して一覧が届いたときに落とす**。
   * ⚠ **`entryMetas` が空のうちに落とさない** ── 起動直後は 0 件なので、
   *   そこで掃除すると**記録が丸ごと消える**(いちばん気づけない壊れ方)。
   *   だから「憶えている 2 件のうち、生きている 1 件だけが残る」で見る。
   */
  it('🔴 起動で、もう無いノートの記録だけが落ちる', () => {
    const { d, store, off } = setup(
      JSON.stringify([
        { lid: 'n1', at: 5 },
        { lid: 'gone', at: 4 },
      ]),
    );
    expect([...store.map().keys()], '生きている行まで落ちた / 落ちていない').toEqual(['n1']);
    expect(d.getState().openedAt.has('gone'), '画面にまだ古い記録が載っている').toBe(false);
    off();
  });

  /**
   * ⚠ **同じ中身なら、新しい参照を作らない**(reducer の側の約束)──
   *   指紋が毎回変われば、一覧が 1 文字も変わっていないのに描き直される。
   */
  it('🔴 同じ表を入れ直しても、state の参照は変わらない', () => {
    const { d, off } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const before = d.getState().openedAt;
    d.dispatch({ type: 'SET_OPENED_AT', openedAt: new Map(before) });
    expect(d.getState().openedAt, '中身が同じなのに参照が変わった').toBe(before);
    off();
  });
});

/**
 * 🔴 **消す口が、押して無言にならない**(#215 残り①)。
 *
 * ⚠ 記録を作ったら消す口も作る ── そして**押した結果が画面に当たる**ことまで見る。
 *   store だけ消すと、いま「最近開いた順」で並べている一覧が**古い並びのまま**残る。
 */
describe('最近開いた記録を消す(設定の口)', () => {
  it('🔴 設定の口 → binder → 保存と画面の両方が消える', () => {
    const root = document.createElement('div');
    document.body.append(root);
    appOpenedStore.push('n1', 123);
    expect(appOpenedStore.map().size, '前提が崩れている: 記録が積めていない').toBe(1);

    const said: string[] = [];
    const sent: { type: string }[] = [];
    const dispatcher = {
      getState: () => initialState,
      dispatch: (a: { type: string }) => void sent.push(a),
    };
    bindActions(root, dispatcher as never, { showStatus: (t) => said.push(t) });
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);

    const btn = root.querySelector<HTMLButtonElement>('[data-pkc-action="clear-opened-history"]');
    expect(btn, '設定に「最近開いた記録を消す」が無い').not.toBeNull();
    btn!.click();

    expect(appOpenedStore.map().size, '押したのに保存が残っている').toBe(0);
    // ⚠ **画面にも反映する** ── 送っていないと、並べ替え中の一覧が古いまま残る
    expect(
      sent.filter((a) => a.type === 'SET_OPENED_AT'),
      '画面へ入れ直していない(消したのに並びが変わらない)',
    ).toHaveLength(1);
    expect(said.join(''), '消えたことを字で言っていない(無言)').toContain('消しました');
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(CLAUDE.md「どの test からも実行され
 * ない file に判断を書かない」)。見るのは **1 本の配線**だけ。
 * ⚠ 弱い pin だと自覚して使う(綴りが合っていることしか見ていない)。
 */
describe('main.ts の配線(原文 pin)', () => {
  it('🔴 起動時に、最近開いたを憶える配線を繋いでいる', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code, '繋いでいない(開いても記録されない = 並べ替えが空になる)').toMatch(
      /connectOpenedEffects\(dispatcher\)/,
    );
  });
});
