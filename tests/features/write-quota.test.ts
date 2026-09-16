/**
 * 🔴 **ノート本体を書く前の容量の門**(#971 段②の残り)。
 *
 * ⚠ ここで守りたいのは 2 つで、**向きが逆**である:
 * ① 空きが無いときに**増やす書き込みを止める**(壊れを作らない)
 * ② 🔴 空きが無くても**消す操作は通す**(止めると user が詰む)
 *
 * 🔑 ②が本題である ── ①だけ書くと「空きが無いので消せません」という
 *   **いちばん悪い形**を自分で作る。
 */
import { describe, expect, it } from 'vitest';
import {
  QUOTA_ALLOWED_WRITES,
  QUOTA_BLOCKED_OPS,
  QUOTA_RECHECK_MS,
  QUOTA_RECHECK_WRITES,
  WRITE_FLOOR_BYTES,
  WRITE_QUOTA_REFUSAL,
  refuseWrite,
  shouldRecheck,
} from '../../src/features/storage/write-quota';
import { CORRUPT_BLOCKED_OPS } from '../../src/features/storage/db-corruption';

const MB = 1024 * 1024;

describe('増やす書き込みだけ止める(#971 段②)', () => {
  /**
   * 🔴 **これがこの file の主張の中心** ── 消す操作を止めると、
   *   空きが無い user は**空きを作る手段を失う**(詰み)。
   */
  it('🔴 消す操作は、止める一覧に 1 つも入っていない', () => {
    for (const op of ['deleteEntry', 'purgeTrash', 'deleteAssetMeta', 'deleteRelation']) {
      expect(QUOTA_BLOCKED_OPS, `空きを作る道を塞いだ: ${op}`).not.toContain(op);
    }
  });

  /**
   * 🔴 **壊れの一覧を使い回さない** ── あちらは消す op も止めるのが正しい
   *   (壊れた DB へは消す書き込みもしたくない)。こちらで同じ一覧を使うと詰む。
   * 🔑 だから「和が一致すること」で**分け忘れ**だけを見る ── op を足した人は、
   *   どちらかへ入れるまで落ちる。
   */
  it('🔴 書き込む op は 1 つ残らず、止める / 通すのどちらかに入っている', () => {
    const classified = new Set([...QUOTA_BLOCKED_OPS, ...QUOTA_ALLOWED_WRITES]);
    // ⚠ 空振り防止 ── 一覧を 1 つも拾えていない状態で「全部仕分け済み」と言わない
    expect(CORRUPT_BLOCKED_OPS.length, '壊れの一覧が空(走査が壊れている)').toBeGreaterThan(10);
    const missing = CORRUPT_BLOCKED_OPS.filter((o) => !classified.has(o));
    expect(
      missing,
      `書き込む op を仕分けていない ── QUOTA_BLOCKED_OPS か QUOTA_ALLOWED_WRITES へ: ${missing.join(' ')}`,
    ).toEqual([]);

    // ⚠ 両方に入っている物は無い(入ると、止まるのか通るのか読めない)
    const both = QUOTA_BLOCKED_OPS.filter((o) => QUOTA_ALLOWED_WRITES.includes(o));
    expect(both, '止めると通すの両方に入っている').toEqual([]);

    // ⚠ 書き込みでない op を止めようとしていない(読みを止めたら持ち出せなくなる)
    const ghosts = [...QUOTA_BLOCKED_OPS, ...QUOTA_ALLOWED_WRITES].filter(
      (o) => !CORRUPT_BLOCKED_OPS.includes(o),
    );
    expect(ghosts, '書き込みでない op が混じっている').toEqual([]);
  });

  it('🔴 本文を書く op は止める(= 門が実際に効いている)', () => {
    expect(QUOTA_BLOCKED_OPS).toContain('upsertEntry');
    expect(QUOTA_BLOCKED_OPS).toContain('bulkUpsertEntries');
  });
});

describe('断るかどうかの判定(#971 段②)', () => {
  it('⚠ 余裕があれば通す', () => {
    expect(refuseWrite({ usage: 1000 * MB, quota: 10_000 * MB })).toBe(false);
  });

  it('🔴 床を割ったら断る(境目の両側を見る)', () => {
    const quota = 10_000 * MB;
    // ⚠ **両側**を見る ── 片側だけだと「always refuse」に壊しても落ちない
    expect(refuseWrite({ usage: quota - WRITE_FLOOR_BYTES, quota }), '床ちょうどで断った').toBe(
      false,
    );
    expect(refuseWrite({ usage: quota - WRITE_FLOOR_BYTES + 1, quota }), '床を割っても通した').toBe(
      true,
    );
  });

  /**
   * 🔴 **読めないときは通す** ── 壊れの門(`db-corruption`)とは**倒し方が逆**である。
   * ⚠ あちらは「書くほど壊れが広がる」ので止めるのが安全だが、こちらは
   *   測れない端末で**保存できないアプリ**にするほうがはるかに害が大きい。
   */
  it('🔴 使用量が読めない端末で、保存できないアプリにしない', () => {
    expect(refuseWrite({}), '読めないのに断った').toBe(false);
    expect(refuseWrite({ usage: 1 * MB }), '片方だけで断った').toBe(false);
    expect(refuseWrite({ quota: 10 * MB }), '片方だけで断った').toBe(false);
    expect(refuseWrite({ usage: Number.NaN, quota: 10 * MB }), 'NaN で断った').toBe(false);
    // ⚠ 上限 0 も「読めていない」と同じ扱い(割り算をしないので Infinity は出ないが、
    //    ここで断ると**上限を返さない端末で一切保存できなくなる**)
    expect(refuseWrite({ usage: 0, quota: 0 }), '上限 0 で断った').toBe(false);
  });
});

describe('測り直す間隔(#971 段②)', () => {
  it('🔴 1 度も測っていないなら、必ず測る', () => {
    // 🔑 起動直後の 1 回目を飛ばすと、**既に一杯の DB を開いた瞬間**を見逃す
    expect(shouldRecheck({ lastAt: null, now: 0, writesSince: 0 })).toBe(true);
  });

  it('⚠ 時間でも回数でも測り直す(片方だけにしない)', () => {
    // 時間は足りないが、回数で届く
    expect(
      shouldRecheck({ lastAt: 1000, now: 1001, writesSince: QUOTA_RECHECK_WRITES }),
      '回数で測り直していない',
    ).toBe(true);
    // 回数は足りないが、時間で届く
    expect(
      shouldRecheck({ lastAt: 0, now: QUOTA_RECHECK_MS, writesSince: 0 }),
      '時間で測り直していない',
    ).toBe(true);
    // ⚠ 対照群 ── どちらも足りなければ測らない(毎回測ると保存が遅くなる)
    expect(
      shouldRecheck({ lastAt: 1000, now: 1001, writesSince: 1 }),
      '毎回測っている(打鍵のたびに estimate を呼ぶと保存が遅い)',
    ).toBe(false);
  });
});

describe('断り文(#971 段②)', () => {
  it('🔴 「消す操作は通る」と言い切る(詰みに見せない)', () => {
    expect(WRITE_QUOTA_REFUSAL, '消せることを言っていない').toContain('消す操作は止めていません');
    expect(WRITE_QUOTA_REFUSAL, '次の一手が無い').toMatch(/何が容量を使っているか|添付を消す/);
  });

  it('⚠ 記法を書かない(素のテキストとして出る面がある)', () => {
    expect(WRITE_QUOTA_REFUSAL).not.toMatch(/[*`_]|\[.*\]\(.*\)/);
  });
});
