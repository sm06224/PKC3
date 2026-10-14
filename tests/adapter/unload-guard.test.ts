/** @vitest-environment happy-dom */
/**
 * 🔴 **書き込みの最中にタブを閉じる・読み直すときだけ、「離れますか」を出す**(#1056)。
 *
 * 守る主張:
 * 1. 飛んでいる書込が 1 件以上 → `beforeunload` が `preventDefault` される(+ `returnValue`)
 * 2. 🔴 **0 件なら何もしない**(普段の閉じるに確認を出さない)── 書込が終わった後も同じ
 * 3. 登録は**重複しない**(`setWriting(true)` が何度来ても `addEventListener` は 1 回)/
 *    終わったら外す(普段は `beforeunload` の持ち主にならない)
 * 4. 🔑 **実物の効果層とつないで**、書込の出入り(`onWriting`)がそのまま効く
 *    (`main.ts` は test から実行されないので、「つないだ形」をここで通す)
 *
 * ⚠ 1・2 は**実際の `beforeunload` を撃って**見る(関数を直に呼ばない)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { createUnloadGuard } from '../../src/adapter/platform/unload-guard';
import { connectPortablePersist } from '../../src/adapter/platform/storage/portable-persist';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';

/** 実際に撃って、止められたか(確認が出る形か)を返す。 */
function fire(target: EventTarget): { prevented: boolean; event: Event } {
  const ev = new Event('beforeunload', { cancelable: true });
  target.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, event: ev };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('離れるときの確認は、書き込みの最中だけ', () => {
  it('🔴 書込中 → beforeunload が止められる(returnValue も空文字で置く)', () => {
    const guard = createUnloadGuard(window);
    guard.setWriting(true);
    const r = fire(window);
    expect(r.prevented, '書いている最中なのに確認が出ない').toBe(true);
    expect((r.event as BeforeUnloadEvent).returnValue).toBe('');
    guard.setWriting(false);
  });

  it('🔴 0 件(一度も書いていない)→ 何もしない', () => {
    const guard = createUnloadGuard(window);
    expect(fire(window).prevented, '書いていないのに確認が出た').toBe(false);
    // 対照群:同じ guard が、書き始めれば止める(前提が空振りでない)
    guard.setWriting(true);
    expect(fire(window).prevented).toBe(true);
    guard.setWriting(false);
  });

  it('🔴 対照群:書込が終わった後 → 何もしない(確認を出しっぱなしにしない)', () => {
    const guard = createUnloadGuard(window);
    guard.setWriting(true);
    expect(fire(window).prevented).toBe(true);
    guard.setWriting(false);
    expect(fire(window).prevented, '書き終わったのに確認が出た').toBe(false);
    // もう一度書き始めれば、また止める(外しっぱなしにしていない)
    guard.setWriting(true);
    expect(fire(window).prevented).toBe(true);
    guard.setWriting(false);
  });

  it('登録は重複しない: 書込中に setWriting(true) が何度来ても addEventListener は 1 回', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const guard = createUnloadGuard(window);
    guard.setWriting(true);
    guard.setWriting(true);
    guard.setWriting(true);
    // ⚠ `window` のオーバーロードは worker 側の型が先に当たる ── 引数は unknown で受けて綴りで拾う
    const only = (m: { mock: { calls: unknown[][] } }): unknown[][] =>
      m.mock.calls.filter((c) => c[0] === 'beforeunload');
    const adds = () => only(add);
    const removes = () => only(remove);
    expect(adds(), 'beforeunload を重複して登録している').toHaveLength(1);
    guard.setWriting(false);
    guard.setWriting(false);
    // 終わったら外す(1 回だけ)── 外した同じ関数で
    expect(removes()).toHaveLength(1);
    expect(removes()[0]![1]).toBe(adds()[0]![1]);
    // 書き始めるたびに 1 回ずつ(外した後の再登録は重複ではない)
    guard.setWriting(true);
    expect(adds()).toHaveLength(2);
    guard.setWriting(false);
  });

  it('🔴 登録を外し忘れても、書いていなければ止めない(保険の側の門)', () => {
    // 外す口を握りつぶした window ── 外れない登録が残る形
    const fake = new EventTarget();
    const guard = createUnloadGuard({
      addEventListener: (t, l) => fake.addEventListener(t, l as EventListener),
      removeEventListener: () => undefined,
    });
    guard.setWriting(true);
    expect(fire(fake).prevented).toBe(true);
    guard.setWriting(false);
    expect(fire(fake).prevented, '外れていない登録が、書いていないのに確認を出した').toBe(false);
  });
});

describe('#1589 ── 持ち主が 2 つ(保存領域への書込 / 可搬版の画像の書き出し)', () => {
  it('🔴 片方が終わっても、もう片方が書いている間は確認を残す', () => {
    const guard = createUnloadGuard(window);
    guard.setWriting(true, 'portable');
    guard.setWriting(true); // 保存領域への書込
    guard.setWriting(false); // 先に終わったのは保存領域の側
    expect(fire(window).prevented, '可搬の書込が残っているのに確認が消えた').toBe(true);
    guard.setWriting(false, 'portable');
    expect(fire(window).prevented, '両方終わったのに確認が出る').toBe(false);
  });

  it('🔴 可搬だけが書いているときも確認が出る(対照群:誰も書いていなければ出ない)', () => {
    const guard = createUnloadGuard(window);
    expect(fire(window).prevented).toBe(false);
    guard.setWriting(true, 'portable');
    expect(fire(window).prevented).toBe(true);
    guard.setWriting(false, 'portable');
    expect(fire(window).prevented).toBe(false);
  });

  it('🔴 収録(capture)も独立した持ち主 ── 3 者のうち 1 者でも残れば確認を残す(#1087)', () => {
    const guard = createUnloadGuard(window);
    guard.setWriting(true, 'capture');
    guard.setWriting(true);
    guard.setWriting(true, 'portable');
    guard.setWriting(false);
    guard.setWriting(false, 'portable');
    expect(fire(window).prevented, '収録が残っているのに確認が消えた').toBe(true);
    guard.setWriting(false, 'capture');
    expect(fire(window).prevented, '全員終わったのに確認が出る').toBe(false);
  });

  it('🔴 確認を出す瞬間に onLeave が呼ばれる / 書いていなければ呼ばれない', () => {
    const guard = createUnloadGuard(window);
    let n = 0;
    guard.onLeave(() => n++);
    fire(window);
    expect(n, '書いていないのに流し始めた').toBe(0);
    guard.setWriting(true, 'portable');
    const r = fire(window);
    expect(n, '離れようとしたのに流し始めない').toBe(1);
    expect(r.prevented).toBe(true);
    guard.setWriting(false, 'portable');
  });

  it('onLeave が落ちても確認は出す', () => {
    const guard = createUnloadGuard(window);
    guard.onLeave(() => {
      throw new Error('流せない');
    });
    guard.setWriting(true, 'portable');
    expect(fire(window).prevented).toBe(true);
    guard.setWriting(false, 'portable');
  });
});

describe('🔑 実物の可搬の保存とつないで(#1589)', () => {
  it('🔴 溜まっている間と書いている間は確認が出て、器に着いたら出ない / 離れる瞬間に流し始める', async () => {
    const guard = createUnloadGuard(window);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let writes = 0;
    const p = connectPortablePersist({
      exportImage: async () => new Uint8Array(8).fill(1),
      write: async () => {
        writes++;
        await gate;
      },
      onState: () => undefined,
      onUnsaved: (u) => guard.setWriting(u, 'portable'),
    });
    guard.onLeave(() => void p.flush().catch(() => undefined));

    expect(fire(window).prevented, '何も溜まっていないのに確認が出る').toBe(false);
    p.touch(); // 1.2 秒の待ちの間(タイマーは進めない)
    expect(writes).toBe(0);
    const r = fire(window);
    expect(r.prevented, '溜まっているのに確認が出ない(#1589 の再現)').toBe(true);
    expect((r.event as BeforeUnloadEvent).returnValue).toBe('');
    // 🔑 離れようとした瞬間に、待たずに書き始めている
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(writes, '離れようとしたのに、流し始めていない').toBe(1);
    // 書いている最中(溜まりは空)も確認は残る
    expect(fire(window).prevented, '書いている最中に確認が消えた').toBe(true);
    release();
    await p.flush();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(fire(window).prevented, '器に着いたのに確認が出る').toBe(false);
    p.dispose();
  });
});

describe('🔑 実物の効果層の書込の出入りが、そのまま効く', () => {
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
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('🔴 保存が飛んでいる間は止め、着地したら止めない', async () => {
    const guard = createUnloadGuard(window);
    let open!: () => void;
    const door = new Promise<void>((r) => (open = r));
    const d = new Dispatcher();
    const effects = connectStoreEffects(
      d,
      {
        ...stubRevisionOps(),
        getBody: async () => '',
        renameEntry: async () => stubStamps(),
        replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
        reorderEntry: async () => stubStamps(),
        persistEntry: async () => {
          await door;
          return stubStamps();
        },
        deleteEntry: async () => {},
        setEntryParent: async () => {},
      },
      { onWriting: (writing) => guard.setWriting(writing) },
    );
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    // 書く前は止めない
    expect(fire(window).prevented).toBe(false);

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '新しい本文' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await flush();
    expect(fire(window).prevented, '保存が飛んでいるのに確認が出ない').toBe(true);

    open();
    await effects.settled();
    expect(fire(window).prevented, '保存が着地したのに確認が出る').toBe(false);
  });
});
