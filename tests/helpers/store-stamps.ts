/**
 * 書込 stub が返す時刻(P9 段①)。
 *
 * 🔑 **本物は必ず値を返す** ── `UPSERT_SQL` が `datetime('now')` を刻み、worker が
 * 同 tx 内で読んで返す。`null` になるのは「行が消えていた」異常系だけ。
 * だから stub も**値を返す** ── `null` を返す stub を置くと、
 * 「時刻が届かない」という**直したはずのバグを test の中で再現**してしまう
 * (CLAUDE.md「stub は本物の意味論を真似る」)。
 *
 * ⚠ 時刻が**進む**ことに意味がある test は、ここを使わず自分で値を作ること
 * (本物は書込ごとに now を刻む ── ここは固定値である)。
 */
import type { EntryStamps } from '@adapter/platform/storage/schema';

/** sqlite の `datetime('now')` と同じ形(`YYYY-MM-DD HH:MM:SS`、UTC)。 */
export const STUB_STAMP = '2026-01-02 03:04:05';

export function stubStamps(): EntryStamps {
  return { createdAt: STUB_STAMP, updatedAt: STUB_STAMP };
}
