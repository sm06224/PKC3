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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
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
let markFailed: (poolName: string) => void;
let lateErrors: () => readonly string[];
let resetSink: () => void;

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
  markFailed = mod.markPoolOpenFailed;
  lateErrors = mod.lateOpenErrors;
  resetSink = mod.resetOpenErrorSinkForTest;
}, 30_000);

afterEach(() => resetSink());

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

/**
 * 🔴 **窓を閉じた後に着く、失敗した試行の残り**(#1311)。
 *
 * 上流 SAHPool は pool の 6 本の file を `Promise.all` で開き、最初の 1 本が落ちた時点で
 * reject する ── 残りの枝の失敗は**窓を閉じた後**にエラー口へ着く。node では
 * それを作れないので、窓を閉じる → 失敗した pool を覚える → 同じ口を直に呼ぶ、で当てる。
 * ⚠ 実ブラウザで「本当に窓の後に着くか」はここでは測っていない(構造から言えるだけ)。
 */
describe('失敗した pool の残りは、窓を閉じた後も console に出さない(#1311)', () => {
  function closeWindowAsFailed(pool: string): void {
    begin();
    sink(`${pool}:`, '窓の中の分');
    end(false); // 開けなかった回
    markFailed(pool);
  }

  it('🔴 窓の後に届く、失敗した pool の接頭の行は console に出ず lateOpenErrors に入る', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      closeWindowAsFailed('pkc3');
      expect(lateErrors().length, '空振り防止: 始めは 0 件').toBe(0);
      sink('pkc3:', 'NoModificationAllowedError: createSyncAccessHandle');
      sink('pkc3:', 'NoModificationAllowedError: createSyncAccessHandle');
      expect(spy, '失敗した pool の残りが console に出た').not.toHaveBeenCalled();
      expect(lateErrors()).toEqual([
        'pkc3: NoModificationAllowedError: createSyncAccessHandle',
        'pkc3: NoModificationAllowedError: createSyncAccessHandle',
      ]);
      // 🔑 対照群: 別の接頭 / 接頭なしは、同じタイミングで 1 回ずつ流れる
      sink('other:', '別の接頭');
      sink('接頭なし');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith('other:', '別の接頭');
      expect(spy).toHaveBeenCalledWith('接頭なし');
      expect(lateErrors().length, '別の接頭まで控えている').toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('markPoolOpenFailed を呼んでいなければ、窓の後の同じ行は今までどおり流れる', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      begin();
      end(false); // 開けなかった回だが、pool を覚えていない
      sink('pkc3:', 'NoModificationAllowedError: createSyncAccessHandle');
      expect(spy).toHaveBeenCalledWith('pkc3:', 'NoModificationAllowedError: createSyncAccessHandle');
      expect(lateErrors().length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('開けた回(endOpeningStorage(true))の後は、pool の接頭を覚えず console へ流れる', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      begin();
      sink('pkc3:', '一時の分');
      end(true); // 開けた回 ── 呼び側は markPoolOpenFailed を呼ばない
      sink('pkc3:', '開けた後の pool のエラー');
      expect(spy).toHaveBeenCalledWith('pkc3:', '開けた後の pool のエラー');
      expect(lateErrors().length, '開けた後のエラーを控えている').toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('markPoolOpenFailed は前の回の控えを持ち越さない', () => {
    closeWindowAsFailed('pkc3');
    sink('pkc3:', '前の回の残り');
    expect(lateErrors().length).toBe(1);
    markFailed('pkc3');
    expect(lateErrors().length, '次の回へ控えを持ち越した').toBe(0);
  });

  /**
   * 配線: 開けなかった `catch` が `markPoolOpenFailed(dbName)` を呼ぶこと(node では
   * 開けなかった回を作れないので、原文で見る)。⚠ 注釈を落としてから当てる。
   */
  const SRC = 'src';
  function codeOnly(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('開けなかった catch が markPoolOpenFailed(dbName) を呼ぶ(配線)', () => {
    const text = codeOnly(
      readFileSync('src/adapter/platform/storage/storage-worker.ts', 'utf-8'),
    );
    const m = /catch \(e\) \{\s*fallbackDetail = endOpeningStorage\(false\);[^\n]*\n\s*markPoolOpenFailed\(dbName\);/;
    expect(m.test(text), '開けなかった catch に markPoolOpenFailed(dbName) が無い').toBe(true);
  });

  it('resetOpenErrorSinkForTest は定義の 1 件だけ(製品コードは呼ばない)', () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      readFileSync(f, 'utf-8')
        .split('\n')
        .forEach((l, i) => {
          // 注釈の行は数えない(解説に名前を書いてよい)
          if (l.includes('resetOpenErrorSinkForTest') && !/^\s*(\*|\/\/|\/\*)/.test(l)) {
            hits.push(`${f}:${i + 1}:${l.trim()}`);
          }
        });
    }
    expect(hits.length, '定義以外で resetOpenErrorSinkForTest が使われている').toBe(1);
    expect(hits[0]).toMatch(
      /^src\/adapter\/platform\/storage\/storage-worker\.ts:\d+:export function resetOpenErrorSinkForTest/,
    );
  });
});
