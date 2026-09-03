/**
 * 🔴 **預かった仕事は、1 本ずつ流す**(#666 の着地前レビュー D2)。
 *
 * ## なぜ 1 本ずつでなければならないか
 *
 * `APPEND_TO_ENTRY` は **`writeLock` が立っている間の要求を黙って捨てる**
 * (`app-state.ts`:「書込中の二重要求も断る」)。その錠が解けるのは
 * **worker の ack が返ったとき**なので、**microtask 1 つでは絶対に解けない**。
 * ⚠ つまり預かりをまとめて流すと、**2 本目以降が必ず捨てられる** ── しかも
 * 呼び側は「本文に入れました」と言うので、**入っていないのに入ったと言う**。
 *
 * ## 実際に起きる形(#666 で主経路になった)
 *
 * 写真を **3 枚**まとめて落とす → 1 枚目はその場で入って錠が立つ → 2 枚目・3 枚目は
 * 預かりへ積まれる → 錠が解けた瞬間に 2 本まとめて流れ、**3 枚目が消える**。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { createWritableQueue } from '../../src/adapter/ui/actions/writable-queue';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** ノートを 1 件持つ、素の板(effect 層は繋がない ── 錠は手で解く)。 */
function harness() {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({
    type: 'CREATE_ENTRY',
    archetype: 'text',
    lid: 'n1',
    title: 'メモ',
    body: '# メモ',
    edit: false,
  });
  const seen: string[] = [];
  d.onEvent((e) => {
    if (e.type === 'REQUEST_APPEND') seen.push(e.text);
  });
  const append =
    (text: string) =>
    (): void => {
      d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text, heading: null, target: null });
    };
  /** ⚠ 実物では effect 層が ack で解く ── ここは同じ「解ける」だけを再現する。 */
  const unlock = (): void => {
    d.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
  };
  return { d, seen, append, unlock, q: createWritableQueue(d) };
}

describe('createWritableQueue', () => {
  it('🔴 預かりが 2 本たまっても、1 本も落とさない(#666 D2)', async () => {
    const h = harness();

    // ① 1 本目は**その場で**走り、錠を立てる(前提)
    expect(h.q.push(h.append('a')), '1 本目が預かりになっている(台の前提が崩れた)').toBe(
      false,
    );
    expect(h.d.getState().writeLock, '前提: 錠が立っていない').not.toBeNull();

    // ② 錠が立っている間の 2 本は預かる
    expect(h.q.push(h.append('b'))).toBe(true);
    expect(h.q.push(h.append('c'))).toBe(true);
    expect(h.seen, '預かるはずの物が走った').toEqual(['a']);

    // ③ 錠が解ける → **1 本だけ**流れる(2 本流すと 2 本目が reducer に捨てられる)
    h.unlock();
    await tick();
    expect(h.seen, '解けた瞬間に 2 本流して、片方を捨てている').toEqual(['a', 'b']);
    expect(h.q.size(), '3 本目を手放している(もう誰も持っていない)').toBe(1);

    // ④ もう一度解ける → 3 本目が入る。⚠ ここが本題である
    h.unlock();
    await tick();
    expect(h.seen, '3 本目が黙って消えた').toEqual(['a', 'b', 'c']);
    expect(h.q.size()).toBe(0);
  });

  /** ⚠ 対照群 ── 書ける状態なら預からずに走る(常に預かる実装で緑にならない)。 */
  it('⚠ 書ける状態なら預からず、その場で走る', () => {
    const h = harness();
    expect(h.q.push(h.append('a'))).toBe(false);
    expect(h.seen).toEqual(['a']);
  });

  /**
   * 🔴 **`pump` が 2 本飛んでも、同じ 1 本を 2 回走らせない**(#666 の着地前レビュー 7)。
   *
   * ⚠ 1 稿目は `pending[0]` を **microtask の外**で読み、`shift()` を中でしていた ──
   *   2 本飛ぶと**両方が同じ物を掴んで両方 `shift()` する**ので、同じ預かりが 2 回走り、
   *   次の 1 本が**黙って落ちる**(走った順が `A,B,B` になる)。
   * ⚠ 2 本飛ぶ形:`await run()` の最中に `push` が見張りを張り直し、
   *   その見張りと、走り終えた側の続きが**両方 `pump()` を呼ぶ**。
   */
  it('🔴 見張りと続きが同時に動いても、同じ預かりを 2 回走らせない', async () => {
    const h = harness();
    const order: string[] = [];
    const slow =
      (name: string) =>
      async (): Promise<void> => {
        order.push(name);
        await Promise.resolve();
      };
    /**
     * ⚠ **A の中で割り込ませる** ── `await run()` の最中に `push` が見張りを
     *   張り直し、その見張りが鳴って `pump()` が 2 本目として飛ぶ形を作る。
     *   ⚠ A が終わってから足すのでは**重ならない**(1 稿目はそれで空振りした)。
     */
    const first = async (): Promise<void> => {
      order.push('A');
      h.q.push(slow('C')); // 預かりへ積まれ、見張りが張り直される
      h.unlock(); // その見張りが鳴って pump() が飛ぶ
      await Promise.resolve();
    };
    h.q.push(h.append('lock')); // 錠を立てる(以降は預かりになる)
    h.q.push(first);
    h.q.push(slow('B'));
    for (let i = 0; i < 6; i += 1) {
      h.unlock();
      await tick();
    }
    expect(order, '同じ預かりを 2 回走らせた(次の 1 本が落ちている)').toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(h.q.size()).toBe(0);
  });

  /**
   * 🔴 **順番を守る** ── 預かりが在るときは、書けても割り込ませない。
   * ⚠ 割り込ませると、落とした順と本文の並びが食い違う(3 枚落として 2 枚目が末尾)。
   */
  it('🔴 預かりが在る間に来た仕事は、順番のうしろへ着く', async () => {
    const h = harness();
    h.q.push(h.append('a')); // 走る
    h.q.push(h.append('b')); // 預かり
    h.unlock();
    // ⚠ 解けた**直後**(まだ b が走る前)に来た 3 本目
    expect(h.q.push(h.append('c')), '割り込んで先に走った').toBe(true);
    await tick();
    h.unlock();
    await tick();
    h.unlock();
    await tick();
    expect(h.seen).toEqual(['a', 'b', 'c']);
  });
});
