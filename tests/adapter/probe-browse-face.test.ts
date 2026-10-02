/** @vitest-environment happy-dom */
/**
 * 🔴 **probe の観測点の解き方を、CI で確定的に鳴らす**(2026-08-18、#265)。
 *
 * probe 本体は nightly でしか走らないので、壊れても **PR gate は 1 つも鳴らない**
 * ── 実際 #259 で既定のタブが `filer-table` に変わった日、3 本の probe が
 * `entry-list`(hidden 側)を名指ししたまま **60 秒 待って timeout** していた。
 * ここでは `resolveListFace` の**判断そのもの**を unit で pin する。
 *
 * ⚠ **測っている範囲を正直に書く。** ブラウザ側の「見えているか」の信号
 * (`getClientRects`)は happy-dom が実装しきっていないので、ここでは
 * **信号を与えたうえでの判断**だけを見る(信号そのものが取れることは
 * probe が実機で確かめる ── 4 本とも `filer-table` を解いて通っている)。
 */
import { describe, expect, it } from 'vitest';
import { resolveListFace, LIST_FACES } from '../probe/browse-face.mjs';

/** `page.evaluate` の最小の身代わり ── 渡した関数をこの document で実行する。 */
function fakePage(): { evaluate: (fn: (a: string[]) => unknown, arg: string[]) => Promise<unknown> } {
  return { evaluate: (fn, arg) => Promise.resolve(fn(arg)) };
}

/**
 * 面を組む。`visible` に挙げた region だけが矩形を持つ。
 * ⚠ `hidden` 属性ではなく `getClientRects` を差す ── 実装が見ているのはそちら
 * (面は CSS でも隠れうるので、属性を見ると隠れ方を 1 つ取りこぼす)。
 */
function layout(present: readonly string[], visible: readonly string[]): void {
  document.body.innerHTML = '';
  for (const region of present) {
    const el = document.createElement('div');
    el.setAttribute('data-pkc-region', region);
    const rects = visible.includes(region) ? [{}] : [];
    Object.defineProperty(el, 'getClientRects', { value: () => rects });
    document.body.append(el);
  }
}

/**
 * ⚠ 「一覧」タブを外した(#813 段③)ので、本物の面は `filer-table` の 1 つになった。
 *   「ちょうど 1 つ見えている」の**判断そのもの**は、面が複数のときのために残してあり
 *   (`faces` 引数)、ここでは**身代わりの 2 面**で見る(判断が壊れたら落ちる)。
 */
const TWO = ['face-a', 'face-b'];

describe('probe の一覧の面を解く(#265)', () => {
  it('🔴 本物の面(いま 1 つ)が見えていれば、それを解く', async () => {
    layout(LIST_FACES, [LIST_FACES[0]!]);
    expect((await resolveListFace(fakePage())).region).toBe('filer-table');
  });

  it('🔴 面が複数のとき、既定が入れ替わっても、見えている面に追随する(両方向)', async () => {
    // ⚠ **両方向**を通す ── 片側だけだと「たまたま今の既定と一致しているだけ」の
    //   名指しが素通りする(それがこの issue の原因そのもの)
    layout(TWO, ['face-a']);
    expect((await resolveListFace(fakePage(), TWO)).region).toBe('face-a');
    layout(TWO, ['face-b']);
    expect((await resolveListFace(fakePage(), TWO)).region).toBe('face-b');
  });

  it('🔴 面が DOM から消えたら、名前を言って落ちる(残った方に救われない)', async () => {
    // 🔑 「どれか 1 つが見えている」だけを条件にすると、面が 1 つ消えても
    //    残った方に満たされて**気づけない**(CLAUDE.md §1「救い手が変わっただけ」)
    layout(['face-a'], ['face-a']);
    await expect(resolveListFace(fakePage(), TWO)).rejects.toThrow('face-b');
    // 本物の面が消えた(名前が変わった)ときも同じ
    layout(['entry-list'], ['entry-list']);
    await expect(resolveListFace(fakePage())).rejects.toThrow('filer-table');
  });

  it('🔴 見えている面が 1 つでないときは測らない(0 個 / 2 個とも)', async () => {
    layout(TWO, []);
    await expect(resolveListFace(fakePage(), TWO)).rejects.toThrow('0 個');
    layout(TWO, TWO);
    await expect(resolveListFace(fakePage(), TWO)).rejects.toThrow('2 個');
    // 本物の面が隠れているときも測らない
    layout(LIST_FACES, []);
    await expect(resolveListFace(fakePage())).rejects.toThrow('0 個');
  });

  it('面の一覧は 1 つ以上ある(空になったら上の判断が何も見なくなる)', () => {
    // ⚠ 空振り防止 ── `LIST_FACES` が空になると「ちょうど 1 つ見えている」は常に偽で
    //   probe が全部止まる(止まるのは正しいが、理由が読めない)
    expect(LIST_FACES.length).toBeGreaterThan(0);
  });
});
