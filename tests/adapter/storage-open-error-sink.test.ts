/** @vitest-environment node */
/**
 * 🔴 **保存先を開こうとしている間だけ、sqlite のエラーログを控える**(#1073)の検査。
 *
 * ## なぜ「直に」呼ぶのか
 *
 * node には OPFS が無いので、`installOpfsSAHPoolVfs` は `sqlite3.config.error` を
 * 1 度も呼ばずに(`Missing required OPFS APIs.` で即 reject する ── 上流の実物で
 * 確認済み)`:memory:` へ落ちる。つまり **node では「開けなかった回」を、この失敗を
 * 経由して再現できない**(CLAUDE.md §2「弱いのではなく走っていない」)。
 * 🔑 だから `beginOpeningStorage` / `endOpeningStorage` / `sqliteOpenErrorSink` を
 * export してもらい、**区間の切り替えそのものを直に**当てる。
 *
 * ⚠ `self` / `postMessage` を先に差すのは、他の unit(`storage-worker.test.ts` /
 * `storage-vfs-config.test.ts`)と同じ理由 ── file 末尾の `self.onmessage = …` が
 * import 時に走る(worker の中には無いので、無いと `self is not defined`)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';

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

let sink: (...args: unknown[]) => void;
let begin: () => void;
let end: (discard: boolean) => string[];

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.self = workerSelf;
  g.postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  const mod = await import('../../src/adapter/platform/storage/storage-worker');
  sink = mod.sqliteOpenErrorSink;
  begin = mod.beginOpeningStorage;
  end = mod.endOpeningStorage;
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

describe('sqlite の error を、開いている間だけ控える(#1073)', () => {
  it('🔴 開いていない間は、いつもどおり console.error へ流す', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sink('pkc3:', 'ordinary error');
      expect(spy, '開いていないのに console.error が呼ばれていない').toHaveBeenCalledWith(
        'pkc3:',
        'ordinary error',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('🔴 開いている間は console に出さず、控えへ溜める', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      begin();
      sink('pkc3:', 'NoModificationAllowedError: …');
      sink('pkc3:', 'removeVfs() failed with no recovery strategy: …');
      expect(spy, '開いている間に console.error が呼ばれた').not.toHaveBeenCalled();
      const detail = end(false); // 開けなかった回 ── 診断として残す
      expect(detail).toEqual([
        'pkc3: NoModificationAllowedError: …',
        'pkc3: removeVfs() failed with no recovery strategy: …',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('🔴 開けたら控えは捨てる(`discard: true`)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      begin();
      sink('pkc3:', '一時のエラー');
      const detail = end(true); // 開けた回 ── 捨てる
      expect(detail, '開けたのに控えが残っている').toEqual([]);
      expect(spy, '控えを捨てるだけで console に出てはいけない').not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * ⚠ **区間は 1 度に 1 つだけ**(#1073 着地前レビュー ⚠2)── 控えは worker 全体で
   *   1 つなので、重ねて入ると片方を抜けた瞬間にもう片方の分が漏れる / 混ざる。
   *   黙って上書きせず投げること、投げても**先の区間は生きたまま**であることを見る。
   */
  it('区間を重ねて入ろうとすると投げ、先の区間の控えは残る', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      begin();
      sink('pkc3:', '先の区間の分');
      expect(() => begin(), '重ねて入れてしまった(黙って控えを捨てる)').toThrow();
      const detail = end(false);
      expect(detail, '重ねて入ろうとした拍子に、先の区間の控えが消えた').toEqual([
        'pkc3: 先の区間の分',
      ]);
      expect(spy).not.toHaveBeenCalled();
      // 🔑 抜けた後なら、また入れる(投げっぱなしで固まらない)
      begin();
      expect(end(true)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('区間を抜けたら、また console.error へ流れる(次の init へ持ち越さない)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      begin();
      sink('pkc3:', '控えの中');
      end(false);
      sink('pkc3:', '区間の外');
      expect(spy, '区間を抜けた後の呼び出しが console に出ていない').toHaveBeenCalledWith(
        'pkc3:',
        '区間の外',
      );
      // ⚠ 直前の区間の分が漏れて混ざっていないこと(空振り防止)
      expect(spy).not.toHaveBeenCalledWith('pkc3:', '控えの中');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * 🔴 **配線そのもの**(init() 経由)── node は OPFS APIs 欠落で即 reject するので、
   *   `sqlite3.config.error` は 1 度も呼ばれない。⚠ そのとき `fallbackDetail` が
   *   `[]` のまま残って**空の配列として載る**変異を、この 1 件が殺す
   *   (`storage-worker.ts` の「渡した量ではなく当てた量」と同じ向き ──
   *   空なら**載せない**契約を守る)。
   */
  it('node の :memory: fallback は config.error を経由しないので fallbackDetail は無い', async () => {
    const init = await request<{ vfs: string; fallbackDetail?: string[] }>({
      op: 'init',
      dbName: 'open-error-sink-test',
    });
    expect(init.vfs, 'node に OPFS は無い ── memory fallback が前提').toBe('memory');
    expect(init.fallbackDetail, '呼ばれていない control.error の分が誤って載っている').toBeUndefined();
  });
});
