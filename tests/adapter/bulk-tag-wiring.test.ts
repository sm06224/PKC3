/** @vitest-environment happy-dom */
/**
 * #402 ①: **まとめてタグを付ける / 外す**(押した所から disk まで)。
 *
 * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
 * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
 *
 * 🔴 **配線の test を別に置く** ── 規則は `bulk-tag.test.ts` が見るが、
 *   それが**画面から届くか**は 1 行も見ていない(#397 で踏んだばかりの穴)。
 *
 * 観測点は **disk に着いた本文**と**画面に出た知らせ**。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { readTags } from '../../src/features/flavor/tags';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)),
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, titles: Record<string, string> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  /**
   * ⚠ **ファイラの器は `buildShell` が持たない**(左の列は `browse.ts` が組む)。
   *   test は自分で器を作って `FilerRenderer` に渡す ── `multi-select.test.ts` と
   *   同じ作法である。
   */
  const filerHost = document.createElement('div');
  root.append(filerHost);
  const filer = new FilerRenderer(filerHost);
  d.onState((s) => filer.render(s));
  bindActions(root, d);
  const disk = { ...bodies };
  /** ⚠ 書いた回数を数える(「変わらないのに書いた」を見るため)。 */
  let writes = 0;
  /** 書込ごとに渡された `expectHash`(門が生きているかを見る)。 */
  const guards: (string | null)[] = [];
  /** この lid の書込は「別の窓に先を越された」ことにする。 */
  const conflictOn = new Set<string>();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      writes++;
      /**
       * 🔴 **`expectHash` を観測する**(2 稿目。変異試験が拾った)。
       * ⚠ 1 稿目の fake は `opts` を見ていなかったので、**門ごと外しても緑**だった
       *   ── 守っていたのは「書けたこと」であって「**別の窓を踏まないこと**」では
       *   なかった(#178 と同じ形の穴を、自分の test に作っていた)。
       */
      guards.push(opts?.expectHash ?? null);
      if (conflictOn.has(e.lid)) return { ...stubStamps(), conflict: true };
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid) => ({
      ...meta(lid),
      ...(titles[lid] === undefined ? {} : { title: titles[lid]! }),
    })),
    relations: [],
  });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, disk, q, guards, conflictOn, writes: (): number => writes };
}

/** 印を付ける(実 UI と同じ action を通す)。 */
function mark(s: ReturnType<typeof setup>, lids: string[]): void {
  for (const lid of lids) s.d.dispatch({ type: 'TOGGLE_SELECT', lid });
}

function press(s: ReturnType<typeof setup>, tag: string, which: 'add' | 'remove'): void {
  s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value = tag;
  s.q(`[data-pkc-action="bulk-tag-${which === 'add' ? 'add' : 'remove'}"]`)!.click();
}

describe('#402 ① まとめてタグを付ける', () => {
  it('🔴 選んだ全部の本文に届く(1 件ずつ開かない)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n', e3: 'う\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), 'e1 に付いていない').toEqual(['請求済']);
    expect(readTags(s.disk['e2']!), 'e2 に付いていない').toEqual(['請求済']);
    // 🔴 選んでいないものは触らない
    expect(s.disk['e3'], '選んでいないものを書き換えた').toBe('う\n');
  });

  it('🔴 既に付いているものは書かない(更新日時を動かさない)', async () => {
    const s = setup({ e1: '---\ntags: [請求済]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(s.writes(), '変わらないものまで書いた').toBe(1);
  });

  it('🔴 内訳を 1 通で言う(既に付いていた件を失敗にしない)', async () => {
    const s = setup({ e1: '---\ntags: [請求済]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    const st = s.d.getState();
    expect(st.notice ?? '', '知らせが出ていない').toContain('1 件に付けました');
    expect(st.notice ?? '').toContain('1 件は既に付いていました');
    // 🔴 **赤い帯にしない**(成功の内訳である)
    expect(st.error, '既に付いていただけでエラーにした').toBeNull();
  });
});

describe('#402 ① まとめてタグを外す(片道にしない)', () => {
  it('🔴 付けたものを、同じ帯から外せる', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!)).toEqual(['請求済']);
    press(s, '請求済', 'remove');
    await tick();
    expect(readTags(s.disk['e1']!), '外せていない').toEqual([]);
    expect(readTags(s.disk['e2']!)).toEqual([]);
  });

  it('⚠ 他のタグは巻き添えにしない', async () => {
    // ⚠ **2 件用意する** ── 帯は 2 件以上でしか出ない(意図どおりの規則)。
    //    1 件の fixture で書いた 1 稿目は、押す物が無くて落ちた
    const s = setup({
      e1: '---\ntags: [家事, 請求済]\n---\nあ\n',
      e2: '---\ntags: [請求済, 買い物]\n---\nい\n',
    });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'remove');
    await tick();
    expect(readTags(s.disk['e1']!), '前に在ったタグが消えた').toEqual(['家事']);
    expect(readTags(s.disk['e2']!), '後ろに在ったタグが消えた').toEqual(['買い物']);
  });
});

describe('#402 ① 別の窓を踏まない', () => {
  it('🔴 読んだ本文の指紋を添えて書く(門が生きている)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(s.guards, '書込に指紋を添えていない(別の窓を黙って上書きする)').toEqual([
      contentHash64Hex('あ\n'),
      contentHash64Hex('い\n'),
    ]);
  });

  it('🔴 先を越されていたら、その 1 件は書かずに数に出す', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    s.conflictOn.add('e1');
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), '踏み潰した').toEqual([]);
    expect(readTags(s.disk['e2']!), '巻き添えで止まった').toEqual(['請求済']);
    expect(s.d.getState().notice ?? '', '黙って落とした').toContain('1 件は書けませんでした');
  });
});

describe('#402 ① 画面に無いものは触らない', () => {
  it('🔴 絞り込みで消えた行には書かない(消す側と同じ規則)', async () => {
    /**
     * ⚠ **絞った後も 2 件は残す** ── 帯は 2 件以上でしか出ない(意図どおりの規則)。
     *   1 件まで絞った 1 稿目は、押す物が無くて落ちた。
     */
    const s = setup(
      { e1: 'あ\n', e2: 'い\n', e3: 'う\n' },
      { e1: '請求 A', e2: '請求 B', e3: 'よそ' },
    );
    mark(s, ['e1', 'e2', 'e3']);
    await tick();
    // ⚠ 印は残るが、表からは消える ── ここが `delete-selected` と同じ規則の要点
    s.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求' });
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), '見えている行に書けていない').toEqual(['請求済']);
    expect(readTags(s.disk['e2']!), '見えている行に書けていない').toEqual(['請求済']);
    expect(readTags(s.disk['e3']!), '画面に無い行に書いた').toEqual([]);
  });
});

describe('#402 ① 断り方', () => {
  it('🔴 タグが空なら理由を出す(押して無反応にしない)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '   ', 'add');
    await tick();
    expect(s.d.getState().error ?? '', '無言で終わった').toContain('タグを入力');
    expect(s.disk['e1'], '断ったのに書いた').toBe('あ\n');
  });

  it('⚠ 断ったときは打った字を残す(打ち直させない)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    const field = s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;
    field.value = '  ';
    s.q('[data-pkc-action="bulk-tag-add"]')!.click();
    await tick();
    expect(field.value, '断ったのに欄を空にした').toBe('  ');
  });

  it('🔑 通ったら欄を空にする(次の 1 つを打てる)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value).toBe('');
  });

  it('⚠ 帯は 2 件以上のときだけ出る(1 件は「居場所」の帯と役割が重なる)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1']);
    await tick();
    expect(s.q('[data-pkc-field="bulk-tag"]'), '1 件で帯が出ている').toBeNull();
    mark(s, ['e2']);
    await tick();
    expect(s.q('[data-pkc-field="bulk-tag"]')).not.toBeNull();
  });
});
