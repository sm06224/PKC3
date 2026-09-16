/**
 * 🔴 **空きが無いとき、増やす書き込みだけが止まる**(#971 段②の残り)。
 *
 * ## なぜ file を分けたか
 *
 * 空きの見張りは worker の**module の変数**(最後に測った値・測った時刻)に
 * 載るので、同じ file の後ろに在る test が全部その状態を引きずる。
 *
 * ## 🔑 ここでいちばん見たいのは「**消す操作が通ること**」である
 *
 * ⚠ 素直に「書き込みを全部止める」と、**空きが無い user は空きを作れなくなる** ──
 *   詰みである。だから対照群を**同じ状態の中に**置く:
 *   同じ 1 回の「もう一杯」の状態で、**書けないが消せる**ことを見る。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import {
  QUOTA_RECHECK_WRITES,
  WRITE_FLOOR_BYTES,
  WRITE_QUOTA_REFUSAL,
} from '../../src/features/storage/write-quota';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const GB = 1024 * 1024 * 1024;
/** ⚠ 偽の計器 ── test が値を差し替える(worker はこれを読む)。 */
let fake = { usage: 1 * GB, quota: 100 * GB };

const entry = (lid: string) => ({
  lid,
  title: `t-${lid}`,
  archetype: 'text',
  body: `本文 ${lid}`,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
});

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  // ⚠ node にも `navigator` は在る(getter)ので、`defineProperty` で被せる
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { estimate: async () => ({ ...fake }) } },
  });
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-quota' });
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

describe('空きが無いときの書き込み(#971 段②)', () => {
  it('🔴 余裕があるうちは、普通に書ける(= 門が常に断つ形になっていない)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('k-ok') });
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'k-ok' })).toContain('本文 k-ok');
  });

  /**
   * 🔴 **本題** ── 空きが尽きたら、増やす書き込みは断り、**消す操作は通す**。
   *
   * ⚠ 前提の assert を先に置く ── 断りが出ないまま下へ進むと、
   *   「消せた」だけを見て**門が効いている証拠がない**まま緑になる。
   */
  it('🔴 一杯になったら書けなくなるが、消すことはできる', async () => {
    // まだ余裕がある状態で、消す対象を 1 件置いておく
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('k-del') });

    // 🔑 計器を「もう一杯」に差し替える(床を 1 バイト割る)
    fake = { usage: 100 * GB - WRITE_FLOOR_BYTES + 1, quota: 100 * GB };

    /**
     * ⚠ **すぐには効かない** ── 毎回は測らない作りなので、測り直す回数まで進める。
     * 🔑 これは「打鍵のたびに `estimate()` を呼んでいない」ことの確認でもある。
     */
    let refusedAt = -1;
    for (let i = 0; i < QUOTA_RECHECK_WRITES + 5; i += 1) {
      try {
        await request({ op: 'upsertEntry', cid: 'c1', entry: entry(`k-fill-${i}`) });
      } catch (e) {
        expect(String(e), '別の理由で落ちた').toContain(WRITE_QUOTA_REFUSAL);
        refusedAt = i;
        break;
      }
    }
    // 前提の assert ── ここが -1 なら「消せた」を見ても意味が無い
    expect(refusedAt, '一杯にしても 1 度も断られなかった(門が効いていない)').toBeGreaterThan(-1);
    // ⚠ 1 回目で断っていたら、毎回 estimate を呼んでいる(保存が遅くなる)
    expect(refusedAt, '毎回測っている').toBeGreaterThan(0);

    // 🔴 **ここが主張** ── 同じ「一杯」の状態で、消す操作は通る
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'k-del' });
    expect(
      await request({ op: 'getBody', cid: 'c1', lid: 'k-del' }),
      '消せていない(空きを作る道が塞がっている)',
    ).toBeNull();

    // ⚠ ごみ箱を空にする(いちばん空きが増える操作)も通る
    await request({ op: 'purgeTrash', cid: 'c1' });

    // ⚠ 対照群 ── 断られているのは**増やす側だけ**である
    await expect(
      request({ op: 'upsertEntry', cid: 'c1', entry: entry('k-after') }),
      '消した直後なのに書けてしまった(門が消えている)',
    ).rejects.toThrow(WRITE_QUOTA_REFUSAL);
  }, 30_000);
});
