/**
 * 本文の画像を資産にする実体(貼付 = #251 の B + C / 押して取り込む = #264 段①+②。
 * 着地前レビューで `main.ts` から取り出した ── あそこは原文を読む test しか持てない)。
 *
 * 🔴 守る主張:
 * 1. **整理中でも断らずに待つ** ── 断ると `blob:` は永久に失われる(貼付に picker は無い)
 * 2. 🔴 **入らなかった 1 件ごとに理由が返る**(#264 段②)── ⚠ 直す前は
 *    `catch { continue }` で理由を捨てており、**読めていたのに画像でなかった**ものまで
 *    呼び側が「読み込めませんでした」と綴っていた(user は再読込を試して永久に直らない)
 * 3. **画像だけ**受ける(読んでみるまで種類は分からない)
 * 4. 整理(未参照 GC)と**排他**である
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ADOPTED_IMAGE_PREFIX,
  HttpStatusError,
  adoptUrls,
  describeAdoptFailures,
  fetchImageBlob,
} from '../../src/adapter/ui/actions/adopt-urls';
import { createAssetGate } from '../../src/adapter/ui/actions/asset-gate';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { AttachDeps } from '../../src/adapter/ui/actions/attach';

const png = (size = 4): Blob => new Blob([new Uint8Array(size)], { type: 'image/png' });

function deps(over: Partial<AttachDeps> = {}) {
  const put: string[] = [];
  const attach: AttachDeps = {
    putBlob: async (key) => void put.push(key),
    putMeta: async () => {},
    listMetas: async () => [],
    hashBlob: async (blob) => `h${blob.size}`,
    ...over,
  };
  return { attach, put };
}

function harness(over: Partial<AttachDeps> = {}) {
  const d = new Dispatcher();
  const gate = createAssetGate(d);
  const { attach, put } = deps(over);
  return {
    gate,
    attach,
    put,
    run: (urls: string[], fetchBlob: (u: string) => Promise<Blob>, prefix?: string) =>
      adoptUrls(
        { gate, attach, fetchBlob, now: () => new Date('2026-08-18T14:30:05') },
        urls,
        prefix,
      ),
  };
}

describe('貼り付けた URL を資産にする', () => {
  it('画像を資産にして `asset:` を返す', async () => {
    const h = harness();
    const { adopted, failures } = await h.run(['data:image/png;base64,AA'], async () => png());
    expect(adopted.get('data:image/png;base64,AA')).toMatch(/^asset:/);
    expect(h.put, 'bytes を置いていない').toHaveLength(1);
    // ⚠ 余計な断りを出していない(黙って成功したのに理由が出る、を作らない)
    expect(failures).toEqual([]);
  });

  it('🔴 画像でないものは受けない ── そして**「読めない」に畳まない**(#264 段②)', async () => {
    const h = harness();
    const { adopted, failures } = await h.run(['blob:x'], async () =>
      new Blob(['x'], { type: 'text/html' }),
    );
    expect(adopted.size, '画像でないものを資産にした').toBe(0);
    expect(h.put).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.url).toBe('blob:x');
    // 🔴 **読めている**(その証拠に種類が言える)── 「読み込めませんでした」は嘘である
    expect(failures[0]!.why, '読めていたのに「読めない」と言った').toContain('画像ではありません');
    expect(failures[0]!.why, 'どう見えたのかが分からない').toContain('text/html');
    expect(failures[0]!.why).not.toContain('読み込めませんでした');
    // ⚠ **こちらでは直せない** ── 断り文の先頭に出すのは直せるものだけ
    expect(failures[0]!.fixable).toBe(false);
  });

  it('空の bytes も受けない(理由は「空」── 種類の話にしない)', async () => {
    const h = harness();
    const { adopted, failures } = await h.run(['blob:x'], async () =>
      new Blob([], { type: 'image/png' }),
    );
    expect(adopted.size).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.why).toContain('空');
    expect(failures[0]!.why, '空なのに種類のせいにした').not.toContain('画像ではありません');
  });

  it('🔴 読めない 1 件で全部を失わない(その 1 件だけ元のまま・理由つき)', async () => {
    const h = harness();
    const { adopted, failures } = await h.run(['blob:a', 'blob:b'], async (u) => {
      if (u === 'blob:a') throw new Error('gone');
      return png();
    });
    expect(adopted.has('blob:a'), '読めないものを資産にした').toBe(false);
    expect(adopted.get('blob:b')).toMatch(/^asset:/);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.url, 'どれが残ったのか分からない').toBe('blob:a');
    expect(failures[0]!.why).toContain('読み込めませんでした');
    // ⚠ 生の例外文(`gone` / `Failed to fetch`)は user に読めないので**出さない**
    expect(failures[0]!.why, '内部の例外文をそのまま出した').not.toContain('gone');
  });

  it('🔴 **404 は「画像ではありません」に化けない**(#264 段②)', async () => {
    const h = harness();
    const { adopted, failures } = await h.run(['https://e.com/x.png'], async () => {
      throw new HttpStatusError(404);
    });
    expect(adopted.size).toBe(0);
    // 🔴 状態番号は**観測値**なので、そのまま出す(直しようが分かる)
    expect(failures[0]!.why, '置き場所が消えているのに理由が読めない').toContain('404');
  });

  it('🔴 **置けない**ときは理由を言い、**直せる**と印を付ける(空き容量)', async () => {
    const h = harness({
      estimate: async () => ({ usage: 100, quota: 100 }),
    });
    const { adopted, failures } = await h.run(['data:image/png;base64,AA'], async () => png());
    expect(adopted.size).toBe(0);
    expect(failures, '直せる原因が user に届かない').toHaveLength(1);
    expect(failures[0]!.why).toContain('空き容量');
    // ⚠ 名前も出す ── 貼付の画像は**この文言が唯一の出口**である
    //   (添付の一覧には並ばない ── 資産だけ置いて entry は作らないため)
    expect(failures[0]!.why, 'どれが置けなかったのか分からない').toContain('貼付画像');
    // 🔴 **直せる側**である ── `describeAdoptFailures` はこれを先頭に出す
    expect(failures[0]!.fixable).toBe(true);
  });

  it('🔴 名乗りは経路ごとに変える(どちらの操作で失敗したかが読める)', async () => {
    const h = harness({ estimate: async () => ({ usage: 100, quota: 100 }) });
    const { failures } = await h.run(
      ['https://e.com/x.png'],
      async () => png(),
      ADOPTED_IMAGE_PREFIX,
    );
    expect(failures[0]!.why).toContain('取込画像');
    expect(failures[0]!.why, '貼付でないのに貼付と名乗った').not.toContain('貼付画像');
  });

  it('🔴 整理・取込の最中でも**断らずに待つ**(`blob:` は貼った瞬間しか読めない)', async () => {
    const h = harness();
    let release = (): void => {};
    const busy = new Promise<void>((r) => {
      release = r;
    });
    // 先に gate を掴む(整理が走っている状態)
    void h.gate(async () => busy);
    const started = h.run(['blob:a'], async () => png());
    // ⚠ まだ動いていない(排他が効いている = この test はその次元を測れている)
    await Promise.resolve();
    expect(h.put, '排他が効いていない(整理中に put した)').toHaveLength(0);
    release();
    const { adopted } = await started;
    expect(adopted.get('blob:a'), '断られて資産にならなかった(貼ったものが永久に失われる)').toMatch(
      /^asset:/,
    );
  });

  it('同じ bytes は 1 件に畳む(content addressing)', async () => {
    const h = harness();
    const { adopted, failures } = await h.run(['blob:a', 'blob:b'], async () => png());
    expect(new Set(adopted.values()).size, '同じ絵なのに別の鍵になった').toBe(1);
    expect(h.put, '同じ bytes を 2 回置いた').toHaveLength(1);
    // ⚠ 余計な断りを出していない(黙って成功したのに理由が出る、を作らない)
    expect(failures).toEqual([]);
  });

  it('空の一覧では gate を掴まない(無駄に待たせない)', async () => {
    const h = harness();
    const spy = vi.fn();
    const { adopted } = await h.run([], async () => {
      spy();
      return png();
    });
    expect(adopted.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('断りを 1 本の文言にする(#264 段②)', () => {
  const f = (why: string, fixable = false, url = 'https://e.com/x.png') => ({ url, why, fixable });

  it('件数と理由を 1 行にする(`state.error` は 1 枠しかない)', () => {
    expect(describeAdoptFailures([f('読み込めませんでした')])).toBe(
      '1 件を取り込めませんでした: 読み込めませんでした',
    );
  });

  it('🔴 同じ理由は 1 回だけ書く(10 枚とも同じ理由なら 10 回書かない)', () => {
    const out = describeAdoptFailures([f('読み込めませんでした'), f('読み込めませんでした')]);
    expect(out).toContain('2 件');
    expect(out.match(/読み込めませんでした/g), '同じ理由を 2 回書いた').toHaveLength(1);
  });

  it('🔴 **直せるものを先に**出す(user が動ける情報を後ろへ回さない)', () => {
    const out = describeAdoptFailures([f('読み込めませんでした'), f('空き容量が足りません', true)]);
    // 🔑 位置で見る ── 「含む」だけだと、後ろに置いても通る
    expect(out.indexOf('空き容量'), '直せる理由が後ろに回った').toBeLessThan(
      out.indexOf('読み込めませんでした'),
    );
  });

  it('🔴 種類が 3 つ以上なら 2 つ書いて**残りを数える**(黙って切らない)', () => {
    const out = describeAdoptFailures([f('あ'), f('い'), f('う'), f('え')]);
    expect(out).toContain('4 件');
    expect(out).toContain('ほか 2 種');
    expect(out, '3 つ目まで書いてしまった').not.toContain('う');
  });
});

describe('読み口(#264 段②)', () => {
  it('🔴 **404 を例外にする** ── しないとエラーページの HTML を「画像ではない」と読む', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      calls.push(u);
      return {
        ok: false,
        status: 404,
        blob: async () => new Blob(['<html>not found</html>'], { type: 'text/html' }),
      };
    });
    await expect(fetchImageBlob('https://e.com/x.png')).rejects.toBeInstanceOf(HttpStatusError);
    // ⚠ 空振り防止 ── 実際に読みに行っている(例外が別の理由で出ていない)
    expect(calls).toEqual(['https://e.com/x.png']);
    vi.unstubAllGlobals();
  });

  it('200 なら bytes を返す(対照群 ── 上の例外が「常に投げる」ではない)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      blob: async () => png(9),
    }));
    const blob = await fetchImageBlob('https://e.com/x.png');
    expect(blob.size).toBe(9);
    vi.unstubAllGlobals();
  });
});
