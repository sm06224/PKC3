/**
 * 🔴 **手持ちのファイルを開く、選び所の印**(#854 段②)。
 *
 * ⚠ ここが守るのは「合成 lid の頭が本物の lid と絶対に被らないこと」だけである ──
 *   開く手順・エラー文言は `tests/adapter/sql-pane.test.ts` の
 *   「SQL の面から、手持ちのファイルを開く」が端から端まで見ている。
 */
import { describe, expect, it } from 'vitest';
import {
  isSqlLocalFileLid,
  SQL_LOCAL_FILE_LID_PREFIX,
  SQL_PICK_LOCAL_FILE_VALUE,
} from '../../src/features/query/sql-local-file';
import { generateLid } from '../../src/adapter/ui/actions/binder';

describe('手持ちのファイルの合成 lid か', () => {
  it('🔴 頭が印そのものなら true', () => {
    expect(isSqlLocalFileLid(`${SQL_LOCAL_FILE_LID_PREFIX}abc-1`)).toBe(true);
  });

  it('⚠ 本物の lid(generateLid())には絶対に当たらない(空振り防止)', () => {
    // ⚠ 「たまたま今回は違った」ではなく、生成の仕組みそのものが被らないことを見る
    // (generateLid はコロンを含まない base36 の時刻+連番 ── 印はコロンを含む)
    for (let i = 0; i < 20; i += 1) {
      expect(isSqlLocalFileLid(generateLid()), `本物の lid を合成と誤認した`).toBe(false);
    }
  });

  it('⚠ 空文字・「この PKC」を表す値には当たらない(対照群)', () => {
    expect(isSqlLocalFileLid('')).toBe(false);
    expect(isSqlLocalFileLid('n1')).toBe(false);
  });

  it('⚠ 「開く…」の選び所の値そのものは、合成 lid ではない', () => {
    // ⚠ 2 つの値(操作の印 / 開いた後の lid)を取り違えない ── 別の意味の値である
    expect(isSqlLocalFileLid(SQL_PICK_LOCAL_FILE_VALUE)).toBe(false);
  });
});
