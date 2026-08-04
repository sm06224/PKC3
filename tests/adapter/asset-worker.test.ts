/** @vitest-environment node */
/**
 * P8 段⑮: 添付の**展開とハッシュをワーカーへ**。
 *
 * > user 指示 2026-08-03(不可侵)「**基本的に重い処理はワーカーにしてください**」
 *
 * 🔴 **測って分かった訂正**(この段の一番大事な記録):
 * 着手時の見立ては「取込に 900ms の long task がある」だったが、絶対時刻で
 * 突き合わせたら **long task は 926〜1849ms、`importPkc2File` の開始(1846ms)
 * より前**だった ── あれは playwright が 5.2MB のファイルをページへ注入する
 * **計器自身のコスト**で、アプリの freeze ではない。
 *
 * 実際のアプリ側の内訳(添付 20 件 × 200KB / 5.2MB):
 * ```
 * parse+JSON  131ms(DOMParser + JSON.parse ── DOM が要るので動かせない)
 * convert       6ms
 * 添付ループ    503ms
 * entries+履歴  54ms      long task は 0 本
 * ```
 * 同じビルドで `?pkc-asset-inline` の有無だけ変えた A/B(交互 2 ペア × 各 3 回の
 * 中央値):メイン実行 **ワーカー 1436/1475ms 対 メイン 1546/1855ms**。
 * ⚠ 向きは 2 ペアとも一貫しているが**幅が重なる**ので、倍率は主張しない。
 *
 * ⚠ **worker は node で動く**(この repo の規律)── `self` を差して実物を読む。
 */
import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  decodeAsset,
  processAsset,
  transferableBuffer,
  WORKER_HASH_MAX_BYTES,
} from '../../src/adapter/platform/asset/asset-codec';
import { AssetClient } from '../../src/adapter/platform/asset/asset-client';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { assetKeyFromHash, HASH_MAX_BYTES } from '../../src/adapter/platform/storage/asset-key';

/**
 * ⚠ **query を付けて読み直す**(module cache を外す)。`self` を差してから
 * 実物を評価しないと、配線(`onmessage` を付ける行)を pin できない。
 * 変数経由にするのは tsc が query 付き path を型解決できないため。
 */
const WORKER = '../../src/adapter/platform/asset/asset-worker';

/** node の crypto/Blob/DecompressionStream はどれも標準で在る。 */
const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

async function sha256Hex(u: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', u);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('添付ワーカーの中身', () => {
  it('🔴 gzip を展開して、展開後の SHA-256 を返す', async () => {
    const raw = bytes('こんにちは、これは添付の中身です。'.repeat(50));
    const gz = gzipSync(Buffer.from(raw));
    const out = await processAsset({
      bytes: gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
      gzipped: true,
    });
    expect(new Uint8Array(out.bytes)).toEqual(raw);
    // ⚠ **展開後**のハッシュ(圧縮形のハッシュだと、同じ中身が別 key に落ちる)
    expect(out.hash).toBe(await sha256Hex(raw));
  });

  it('gzip でないものは素通し(legacy 内蔵 data はそもそも圧縮されていない)', async () => {
    const raw = bytes('生のまま');
    const out = await processAsset({ bytes: raw.buffer.slice(0), gzipped: false });
    expect(new Uint8Array(out.bytes)).toEqual(raw);
    expect(out.hash).toBe(await sha256Hex(raw));
  });

  it('🔴 壊れた gzip は**投げる**(黙って空を返さない)', async () => {
    const broken = bytes('これは gzip ではない');
    await expect(processAsset({ bytes: broken.buffer.slice(0), gzipped: true })).rejects.toBeTruthy();
  });

  it('🔴 閾値は `asset-key.ts` と**同じ**(ずれると同じ bytes が別 key に落ちる)', () => {
    expect(WORKER_HASH_MAX_BYTES).toBe(HASH_MAX_BYTES);
  });

  it('🔴 閾値を超えたら **ハッシュを取らない**(全量を heap に載せない)', async () => {
    // ⚠ 64MB の fixture は作れないので、上限を下げて分岐そのものを踏む
    //    (この seam が無いと「分岐ごと消しても緑」になる ── 実際に変異が生存した)
    const raw = bytes('大きいつもり');
    const big = await processAsset({ bytes: raw.buffer.slice(0), gzipped: false, hashMaxBytes: 4 });
    expect(big.hash, '閾値を超えてもハッシュを取っている').toBeNull();
    expect(new Uint8Array(big.bytes), '中身まで捨てている').toEqual(raw);
    // ⚠ 境界のすぐ下は**取る**(閾値を無効化する変異と区別する)
    const ok = await processAsset({
      bytes: raw.buffer.slice(0),
      gzipped: false,
      hashMaxBytes: raw.byteLength,
    });
    expect(ok.hash).toBe(await sha256Hex(raw));
  });

  it('🔴 hash → key の規則は **1 本**(ワーカー側で採番しない)', () => {
    // 段⑮ でハッシュを取る場所がワーカーへ移ったので、規則が 2 か所に生えかけた。
    // ワーカーは hash を返すだけで、key を作るのは `assetKeyFromHash` だけ
    expect(assetKeyFromHash('a'.repeat(64)).key).toBe(`ast-${'a'.repeat(64)}`);
    expect(assetKeyFromHash('a'.repeat(64)).hash).toBe('a'.repeat(64));
    // ⚠ ハッシュを取っていない(閾値超)ときは**採番へ落ちる**
    const gen = assetKeyFromHash(null);
    expect(gen.hash).toBeNull();
    expect(gen.key.startsWith('ast-')).toBe(true);
    expect(gen.key).not.toMatch(/^ast-[0-9a-f]{64}$/);
    // 🔴 **採番は毎回違う**(`ast-null` のような固定値だと、別の添付が
    //    同じ key に落ちて**中身が上書きされる**)
    expect(gen.key).not.toContain('null');
    const gen2 = assetKeyFromHash(null);
    expect(gen2.key, '採番が固定値になっている(別の添付が同じ key に落ちる)').not.toBe(gen.key);
  });

  it('🔴 `decodeAsset` は **部分 view でも正しい**(呼び側に buffer を組ませない)', async () => {
    // ⚠ ここが本丸 ── 口が view を受けるので呼び側は間違えようがないが、
    //    **口の中で規則を通さない**と結局 buffer 全体を処理してしまう
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const part = whole.subarray(2, 5) as Uint8Array<ArrayBuffer>;
    const out = await decodeAsset(part, false);
    expect(new Uint8Array(out.bytes), 'buffer 全体を処理している').toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(out.hash).toBe(await sha256Hex(new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>));
  });

  it('🔴 部分 view は**切り出してから**渡す(全体を渡すと別物になる)', () => {
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const part = whole.subarray(2, 5) as Uint8Array<ArrayBuffer>;
    const out = transferableBuffer(part);
    expect(new Uint8Array(out), '部分参照なのに buffer 全体を渡している').toEqual(
      new Uint8Array([3, 4, 5]),
    );
    // ⚠ ぴったりのときは**そのまま**(無駄なコピーを作らない)
    const exact = new Uint8Array([9, 9]) as Uint8Array<ArrayBuffer>;
    expect(transferableBuffer(exact)).toBe(exact.buffer);
  });
});

/**
 * P8 段⑮: メインスレッド側の口。
 * ⚠ ここでしか見えないもの ── **transfer しているか**は smoke では観測できない
 * (しなくても動く。遅くなるだけ)。変異試験で実際に生き残った。
 */
describe('AssetClient(メイン側の口)', () => {
  class FakeWorker {
    static made: FakeWorker[] = [];
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    readonly sent: Array<{ msg: { id: number; payload: { bytes: ArrayBuffer } }; transfer?: unknown[] }> =
      [];
    constructor() {
      FakeWorker.made.push(this);
    }
    postMessage(msg: { id: number; payload: { bytes: ArrayBuffer } }, transfer?: unknown[]): void {
      this.sent.push({ msg, transfer });
      // 受け取ったものをそのまま返す(配線だけ見る)
      queueMicrotask(() =>
        this.onmessage?.({
          data: { id: msg.id, ok: true, result: { bytes: msg.payload.bytes, hash: 'h' } },
        }),
      );
    }
    terminate(): void {}
  }

  it('🔴 bytes を **transfer で渡す**(4MB を 2 部作らない)', async () => {
    FakeWorker.made.length = 0;
    const client = new AssetClient({
      spawn: () => new FakeWorker() as unknown as Worker,
      monitor: new JobMonitor(),
    });
    expect(client.offloaded, 'ワーカーを使っていない').toBe(true);
    const view = new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>;
    await client.process(view, false);
    const w = FakeWorker.made[0]!;
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.transfer, 'transfer していない(bytes が丸ごとコピーされる)').toEqual([
      w.sent[0]!.msg.payload.bytes,
    ]);
    expect(new Uint8Array(w.sent[0]!.msg.payload.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    client.dispose();
  });

  it('🔴 部分 view を渡しても、**その範囲だけ**がワーカーへ行く', async () => {
    FakeWorker.made.length = 0;
    const client = new AssetClient({
      spawn: () => new FakeWorker() as unknown as Worker,
      monitor: new JobMonitor(),
    });
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    await client.process(whole.subarray(2, 5) as Uint8Array<ArrayBuffer>, false);
    const sent = FakeWorker.made[0]!.sent[0]!;
    expect(
      new Uint8Array(sent.msg.payload.bytes),
      'buffer 全体を送っている(受け手が別物を保存する)',
    ).toEqual(new Uint8Array([1, 2, 3]));
    client.dispose();
  });

  it('ワーカーが無い環境では**同じ関数**をその場で回す(出口を 2 本作らない)', async () => {
    const client = new AssetClient({ spawn: undefined, monitor: new JobMonitor() });
    // happy-dom / node には `Worker` が無いので inline へ落ちる
    expect(client.offloaded).toBe(false);
    const raw = bytes('同じ結果');
    const out = await client.process(raw, false);
    expect(out.hash, 'inline 経路が別の答えを出している').toBe(await sha256Hex(raw));
  });
});

describe('worker の配線(node で実物を読む)', () => {
  it('🔴 結果を **transfer で返す**(4MB を 2 部作らない)', async () => {
    const posted: Array<{ msg: unknown; transfer?: Transferable[] }> = [];
    const fake = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage: (msg: unknown, transfer?: Transferable[]) => posted.push({ msg, transfer }),
    };
    vi.stubGlobal('self', fake);
    try {
      // ⚠ 実物を読む(query で cache を外す ── 1 度しか評価されないと配線が pin できない)
      await import(`${WORKER}?worker-wiring`);
      const raw = bytes('中身');
      fake.onmessage!({ data: { id: 7, payload: { bytes: raw.buffer.slice(0), gzipped: false } } });
      await new Promise((r) => setTimeout(r, 20));
      expect(posted).toHaveLength(1);
      const { msg, transfer } = posted[0]!;
      const m = msg as { id: number; ok: boolean; result: { bytes: ArrayBuffer } };
      expect(m.id).toBe(7);
      expect(m.ok).toBe(true);
      // 🔴 ここが本丸 ── bytes が transfer 一覧に載っていること
      expect(transfer, 'transfer していない(bytes が丸ごとコピーされる)').toEqual([
        m.result.bytes,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('🔴 落ちた 1 件は `ok:false` で返る(取込全体を止めない)', async () => {
    const posted: unknown[] = [];
    const fake = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage: (msg: unknown) => posted.push(msg),
    };
    vi.stubGlobal('self', fake);
    try {
      await import(`${WORKER}?worker-fail`);
      fake.onmessage!({
        data: { id: 1, payload: { bytes: bytes('壊れている').buffer.slice(0), gzipped: true } },
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ id: 1, ok: false });
      expect(String((posted[0] as { error: string }).error)).not.toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
