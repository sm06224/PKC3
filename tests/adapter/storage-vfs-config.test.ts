/** @vitest-environment node */
/**
 * 🔴 **使わない OPFS VFS を用意させない**(#114)の検査。
 *
 * ⚠ **node で回す** ── worker の中に DOM は無い。`self` を差して実物を dynamic
 * import すれば node で走る(`storage-worker.test.ts` と同じ手法)。
 *
 * ## なぜ「代入を捕まえる」形なのか
 *
 * 上流(`@sqlite.org/sqlite-wasm`)は `globalThis.sqlite3ApiConfig` を **読んだ後に
 * 自分で `delete` する**。したがって init 後に値を見にいく検査は**必ず undefined**で、
 * 「設定していない実装」と見分けがつかない ── 空振りにしかならない。
 * 🔑 だから **setter を先に仕掛けて、渡された物そのもの**を採る。
 *
 * ## この検査が守れないもの(自覚して使う)
 *
 * SAHPool が生きていることは**ここでは見えない**(node に OPFS が無く、init は
 * `:memory:` へ落ちる)。それは実ブラウザで確かめてある ── 2026-08-17 の
 * 12 回の probe で、両腕とも状態行の vfs が `opfs-sahpool` であることを見た
 * (⚠ ここが `memory` に落ちていたら常駐が減っても**別の理由**である)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';

/** 上流へ渡された設定(代入の瞬間に捕まえる)。 */
let handed: unknown;

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<T>(req: StorageRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as T) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.self = workerSelf;
  g.postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  // ⚠ **import より前**に仕掛ける(代入は init の中で 1 度だけ起きる)。
  //   ⚠ そして **data property へ戻す** ── 戻さないと上流が読めず、
  //   「検査のために本番の経路を壊した」ことになる。
  Object.defineProperty(globalThis, 'sqlite3ApiConfig', {
    configurable: true,
    set(v: unknown) {
      handed = v;
      Object.defineProperty(globalThis, 'sqlite3ApiConfig', {
        value: v,
        writable: true,
        configurable: true,
      });
    },
    get: () => undefined,
  });
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request<{ vfs: string }>({ op: 'init', dbName: 'vfs-config-test' });
  // 空振り防止 ── init が通っていなければ、下の 0 件は「設定した証拠」ではない
  expect(init.vfs, 'node に OPFS は無い ── memory fallback が前提').toBe('memory');
}, 30_000);

describe('sqlite の init(#114)', () => {
  it('🔴 使わない `opfs` / `opfs-wl` を建てさせない設定を渡している', () => {
    const cfg = handed as { disable?: { vfs?: Record<string, unknown> } } | undefined;
    expect(cfg, '上流へ設定を 1 度も渡していない').toBeDefined();
    // ⚠ 鍵の綴りごと pin する ── 上流は**鍵ごとに別の門**を見ているので、
    //   1 文字違うと**黙って効かない**(worker が 1 本ずつ戻ってくる)
    expect(cfg?.disable?.vfs?.opfs).toBe(true);
    expect(cfg?.disable?.vfs?.['opfs-wl']).toBe(true);
  });

  it('🔴 **SAHPool の門は閉じない**(閉じたら DB 本体が建たない)', () => {
    const vfs = (handed as { disable?: { vfs?: Record<string, unknown> } }).disable?.vfs ?? {};
    // ⚠ 「`opfs-sahpool` が true でない」ではなく **鍵が無い**ことを見る ──
    //   `false` を書くのも上流から見れば同じだが、こちらは
    //   「使う VFS の門には触らない」という**意図**を pin したい
    expect(Object.keys(vfs).sort()).toEqual(['opfs', 'opfs-wl']);
  });
});
