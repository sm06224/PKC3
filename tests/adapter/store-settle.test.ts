/** @vitest-environment happy-dom */
/**
 * 🔴 **飛んでいる書込が着地するのを待てる**(`connectStoreEffects().settled()`)。
 *
 * 直したバグ(2026-08-17 実測): 書込は effect 層の **1 本の chain に直列化**される
 * のに、書き出しの読み(`getBody`)は**その外**から worker を直に叩くので、
 * 並んでいる書込を**追い越す**。実ブラウザで保存の 90ms 後に Word を押すと
 * **11/12 が保存前の本文**を書き出した(800ms 待つ対照群は 0/12)。
 *
 * ⚠ ここが見るのは**待てること**だけ。「書き出しが実際に待つか」は
 * `tests/adapter/export-entry-guard.test.ts` が出口ごとに見る(CLAUDE.md §7)。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

/**
 * 待ち行列を**一巡させる**。
 * ⚠ `await Promise.resolve()` を数回では足りない ── promise の鎖は微小タスクを
 * 何段も進むので、**「まだ返っていない」の観測点が早すぎる**と、待っていない実装でも
 * 緑になる(変異試験 S4 が実際に生き延びた)。macrotask を挟んで全部流す。
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** 手で開けられる門(= 書込が「まだ着いていない」状態を作る)。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** 1 件のノートを編集して保存する(= PERSIST_ENTRY を 1 つ積む)。 */
function commit(d: Dispatcher, lid: string, body: string): void {
  d.dispatch({ type: 'SELECT_ENTRY', lid });
  d.dispatch({ type: 'BODY_LOADED', lid, body: '' });
  d.dispatch({ type: 'START_EDIT' });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body });
  d.dispatch({ type: 'COMMIT_EDIT' });
}

function setup(
  persist: (body: string) => Promise<void>,
  onWriting?: (writing: boolean) => void,
) {
  const d = new Dispatcher();
  const written: string[] = [];
  const effects = connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      await persist(e.body);
      written.push(e.body);
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  }, onWriting ? { onWriting } : {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  return { d, effects, written };
}

describe('書込の着地を待つ(settled)', () => {
  it('🔴 飛んでいる書込が終わるまで返らない', async () => {
    const g = gate();
    const { d, effects, written } = setup(() => g.wait);
    commit(d, 'n1', '新しい本文');

    let done = false;
    const p = effects.settled().then(() => {
      done = true;
    });
    // ⚠ 待ち行列を一巡させても、門が閉じている間は返らない
    await flush();
    expect(done, '書込が終わっていないのに返った').toBe(false);
    expect(written).toHaveLength(0);

    g.open();
    await p;
    expect(done).toBe(true);
    expect(written).toEqual(['新しい本文']);
  });

  /**
   * ⚠ **待っている間に積まれた仕事も待つ** ── chain の tail は `enqueue` が
   * 差し替えるので、1 度 await しただけでは「待ち始めた時点の分」しか見ない。
   */
  it('🔴 待っている間に積まれた書込も待つ', async () => {
    const first = gate();
    const second = gate();
    let n = 0;
    const { d, effects, written } = setup(() => (n++ === 0 ? first.wait : second.wait));
    commit(d, 'n1', '1 本目');

    let done = false;
    const p = effects.settled().then(() => {
      done = true;
    });
    // 1 本目が飛んでいる最中に 2 本目を積む
    commit(d, 'n1', '2 本目');
    first.open();
    await flush();
    expect(done, '2 本目を置き去りにして返った').toBe(false);

    second.open();
    await p;
    expect(written).toEqual(['1 本目', '2 本目']);
  });

  it('⚠ 何も飛んでいなければ、すぐ返る(待ちっぱなしにしない)', async () => {
    const { effects } = setup(async () => {});
    await expect(effects.settled()).resolves.toBeUndefined();
  });

  it('⚠ 書込が失敗しても返る(chain は `then(op, op)` なので死なない)', async () => {
    const { d, effects } = setup(async () => {
      throw new Error('disk full');
    });
    commit(d, 'n1', 'x');
    await expect(effects.settled()).resolves.toBeUndefined();
  });
});

/**
 * 🔴 **「まだ書いています」を外へ知らせる**(#828)。
 *
 * ## なぜ要るか(実測)
 *
 * 題名の書換えは **画面が先・disk が後**である(`RENAME_ENTRY_TITLE` が
 * `entryMetas` を楽観更新し、`REQUEST_RENAME` が後から飛ぶ)。⚠ その間に
 * 読み直すと**題名だけが既定へ戻る** ── 2026-09-09、CPU に 4 本の負荷を掛けて
 * `sub-path.smoke.spec.ts` を 6 回回したら **1 回**出た(負荷なしでは 0 / 多数)。
 * 控えた DOM には**ノートの行は在り、題名だけが `2026-09-09 ノート 1`** だった。
 *
 * 🔑 だから「届いた」と言える観測点を 1 つ置く ── `settled()` は**待つ**口で、
 *   こちらは**知らせる**口である(待てない相手 = smoke / 将来の画面表示のため)。
 * ⚠ ここは**知らせるだけ**で、まだ何も見た目を変えない(見え方を変える判断は
 *   user のもの ── CLAUDE.md)。
 */
describe('書いている間だけ知らせる(#828)', () => {
  it('🔴 書込が飛んだら true、着地したら false', async () => {
    const g = gate();
    const seen: boolean[] = [];
    const { d } = setup(() => g.wait, (w) => seen.push(w));
    // ⚠ 空振り防止 ── 何も書いていないうちは 1 度も呼ばれない
    expect(seen, '書いていないのに知らせが出た').toEqual([]);

    commit(d, 'n1', '新しい本文');
    expect(seen, '書き始めを知らせていない').toEqual([true]);
    await flush();
    expect(seen, '門が閉じている(= まだ書いている)のに false が出た').toEqual([true]);

    g.open();
    await flush();
    expect(seen, '着地を知らせていない').toEqual([true, false]);
  });

  /**
   * 🔴 **変わったときだけ呼ぶ** ── 2 本続けて積んでも `true` は 1 回で、
   *   `false` は**全部着地してから** 1 回である。
   * ⚠ ここが壊れると、画面に出す側が点滅する(将来「保存中」を出すときの土台)。
   */
  it('🔴 2 本積んでも true は 1 回、false は最後の 1 回だけ', async () => {
    const first = gate();
    const second = gate();
    let n = 0;
    const seen: boolean[] = [];
    const { d } = setup(
      () => (n++ === 0 ? first.wait : second.wait),
      (w) => seen.push(w),
    );
    commit(d, 'n1', '1 本目');
    commit(d, 'n1', '2 本目');
    expect(seen, '積むたびに知らせている').toEqual([true]);

    first.open();
    await flush();
    expect(seen, '1 本目が着いただけで「書き終えた」と言った').toEqual([true]);

    second.open();
    await flush();
    expect(seen, '全部着いたのに知らせていない').toEqual([true, false]);
  });

  /**
   * 🔴 **失敗しても false を出す**(出さないと「永遠に書いている」で固まる)。
   * ⚠ chain は `then(op, op)` で死なないので、**知らせだけ取り残される**形になる。
   */
  it('🔴 書込が失敗しても、書き終えたことを知らせる', async () => {
    const seen: boolean[] = [];
    const { d } = setup(async () => {
      throw new Error('disk full');
    }, (w) => seen.push(w));
    commit(d, 'n1', 'x');
    await flush();
    expect(seen, '失敗した回に印が残りっぱなしになる').toEqual([true, false]);
  });

  /**
   * ⚠ **知らせ先が投げても、書込は止まらない**(知らせはおまけである)。
   * 🔑 空振り防止に「本文が実際に書かれた」ことまで見る ── 投げた時点で
   *   列が止まっていれば、ここが 0 件になる。
   */
  it('⚠ 知らせ先が投げても、書込は最後まで走る', async () => {
    const { d, effects, written } = setup(async () => {}, () => {
      throw new Error('画面の都合');
    });
    commit(d, 'n1', '書けたか');
    await effects.settled();
    expect(written, '知らせ先の例外が書込を止めた').toEqual(['書けたか']);
  });
});
