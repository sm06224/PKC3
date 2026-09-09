/**
 * 🔴 **窓ごとの合言葉**(#836。`src/adapter/platform/storage/store-port.ts`)。
 *
 * ## なぜ要るか
 *
 * SQL の面は**同じタイルを 2 回押せば 2 枚開く**(#300 段③ の裁定)。取り込んだ
 * `.sqlite` の接続は**本体タブの worker に在る**ので、どの窓の客かを渡さないと
 * 2 枚が取り合う ── 窓 A の名札は `売上.sqlite` のまま、中身は窓 B の `顧客.db`。
 *
 * ⚠ worker 側の分け方は `tests/adapter/storage-worker.test.ts` が見ている。
 * 🔴 **ここが見るのは「合言葉が窓ごとに違うこと」だけ** ── ここが同じ字を返すと、
 *   worker がいくら分けても**全部同じ客に集まる**(直す前と同じ画面に戻る)。
 *   ⚠ そして worker の test は全部緑のままなので、**誰も気づけない**。
 */
import { describe, expect, it, vi } from 'vitest';
import { createStorePort } from '../../src/adapter/platform/storage/store-port';

/** 送られた要求をそのまま控える偽の client。 */
function spyClient(): { port: ReturnType<typeof createStorePort>; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    request: vi.fn(async (req: unknown) => {
      sent.push(req);
      return { tables: [], bytes: 0 } as unknown;
    }),
  } as unknown as Parameters<typeof createStorePort>[0];
  return { port: createStorePort(client, 'c1'), sent };
}

const guestOf = (req: unknown): unknown => (req as { guest?: unknown }).guest;

describe('取り込んだ .sqlite の合言葉は、窓ごとに違う(#836)', () => {
  it('🔴 2 つの窓は、違う合言葉で開く', async () => {
    const a = spyClient();
    const b = spyClient();
    await a.port.openSqlGuest?.(new Uint8Array([1]));
    await b.port.openSqlGuest?.(new Uint8Array([2]));
    const ka = guestOf(a.sent[0]);
    const kb = guestOf(b.sent[0]);
    // ⚠ 空振り防止 ── そもそも合言葉を渡していること
    expect(typeof ka, '合言葉を渡していない').toBe('string');
    expect(String(ka).length, '合言葉が空(worker 側で全部 1 つに集まる)').toBeGreaterThan(0);
    expect(ka, '2 つの窓が同じ合言葉を使っている(客を取り合う)').not.toBe(kb);
  });

  it('🔴 同じ窓では、開く・外す・打つ が同じ合言葉になる', async () => {
    const { port, sent } = spyClient();
    await port.openSqlGuest?.(new Uint8Array([1]));
    await port.closeSqlGuest?.();
    await port.runReadOnlySql?.('SELECT 1', {
      maxRows: 1,
      maxSteps: 1,
      maxMs: 1,
      guest: true,
    });
    const keys = sent.map(guestOf);
    expect(keys, '3 つの口が揃っていない(前提が崩れている)').toHaveLength(3);
    expect(new Set(keys).size, '同じ窓なのに口ごとに別の合言葉を送っている').toBe(1);
  });

  /**
   * ⚠ **この PKC のノートを調べるときは、合言葉を送らない** ── 送ると worker が
   *   「客の側へ打て」と読むので、**ノートを数えたつもりで客を数える**。
   */
  it('🔴 ノートを調べるときは、合言葉を送らない', async () => {
    const { port, sent } = spyClient();
    await port.runReadOnlySql?.('SELECT 1', { maxRows: 1, maxSteps: 1, maxMs: 1 });
    expect(guestOf(sent[0]), 'ノート側なのに客の合言葉を送っている').toBeUndefined();
  });
});
