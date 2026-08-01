/**
 * PKC2 の `textlog.csv` → TextlogBody の逆写像。
 *
 * PKC2 の契約(`features/textlog/textlog-csv.ts` を実地確認)を踏襲する:
 * header は**名前で**引く / 並びは append 順(re-sort しない)/
 * `flags` 列があればそれが正(空 = flags 無し)/ 未知 flag は落とす。
 * **変えたのは 1 点**: log_id の無い行の skip を**件数で返す**(黙って落とさない)。
 */
import { describe, expect, it } from 'vitest';
import { parseTextlogCsv, TextlogCsvError } from '../../src/features/import/textlog-csv';

const HEADER =
  '"log_id","timestamp_iso","timestamp_display","important","text_markdown","text_plain","asset_keys","flags"';
const row = (...f: string[]) => f.map((v) => `"${v.replace(/"/g, '""')}"`).join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n');

describe('parseTextlogCsv', () => {
  it('基本形を読む(append 順を保つ ── 並べ替えない)', () => {
    const got = parseTextlogCsv(
      csv(
        row('log-2', '2026-07-02T00:00:00Z', '7/2', 'false', '2 番目', '2 番目', '', ''),
        row('log-1', '2026-07-01T00:00:00Z', '7/1', 'false', '1 番目', '1 番目', '', ''),
      ),
    );
    // timestamp では並べ替えない(textlog の不変条件 = append 順)
    expect(got.entries.map((e) => e.id)).toEqual(['log-2', 'log-1']);
    expect(got.entries[0]!.text).toBe('2 番目');
    expect(got.entries[0]!.createdAt).toBe('2026-07-02T00:00:00Z');
    expect(got.skippedRows).toBe(0);
  });

  it('RFC4180: 埋め込みの改行・カンマ・二重引用符を復元する', () => {
    const text = '1 行目\r\n2 行目, カンマ入り\n"引用" つき';
    const got = parseTextlogCsv(csv(row('l1', 'ts', 'd', 'false', text, '', '', '')));
    expect(got.entries[0]!.text).toBe(text);
  });

  it('🔑 header は名前で引く ── 列が並び替わっても増えても壊れない', () => {
    const head = '"extra","text_markdown","log_id","flags","timestamp_iso"';
    const got = parseTextlogCsv(
      [head, '"無視","本文","l1","important","2026-07-01T00:00:00Z"'].join('\r\n'),
    );
    expect(got.entries).toEqual([
      { id: 'l1', text: '本文', createdAt: '2026-07-01T00:00:00Z', flags: ['important'] },
    ]);
  });

  it('flags 列があればそれが正 ── 空は「flags 無し」で important に戻らない', () => {
    // 新しい writer が「この行に flags は無い」と宣言する手段なので、
    // important=true でも空の flags を優先する
    const got = parseTextlogCsv(
      csv(
        row('l1', 'ts', 'd', 'true', 'a', '', '', ''),
        row('l2', 'ts', 'd', 'false', 'b', '', '', 'important'),
      ),
    );
    expect(got.entries[0]!.flags).toEqual([]);
    expect(got.entries[1]!.flags).toEqual(['important']);
  });

  it('flags 列が無い旧 CSV は important から推定する', () => {
    const head = '"log_id","timestamp_iso","important","text_markdown"';
    const got = parseTextlogCsv(
      [head, '"l1","ts","TRUE","a"', '"l2","ts","false","b"'].join('\r\n'),
    );
    expect(got.entries[0]!.flags).toEqual(['important']); // 大文字小文字を問わない
    expect(got.entries[1]!.flags).toEqual([]);
  });

  it('未知の flag token は落とす(前方互換)/ 重複は 1 回', () => {
    const got = parseTextlogCsv(
      csv(row('l1', 'ts', 'd', 'false', 'a', '', '', 'important, future-flag ,IMPORTANT')),
    );
    expect(got.entries[0]!.flags).toEqual(['important']);
  });

  it('log_id の無い行は skip するが**件数を返す**(黙って落とさない)', () => {
    const got = parseTextlogCsv(
      csv(
        row('l1', 'ts', 'd', 'false', 'a', '', '', ''),
        row('', 'ts', 'd', 'false', '壊れた行', '', '', ''),
        row('l2', 'ts', 'd', 'false', 'b', '', '', ''),
      ),
    );
    expect(got.entries.map((e) => e.id)).toEqual(['l1', 'l2']); // 残りは失わない
    expect(got.skippedRows).toBe(1);
  });

  it('見出し行だけの CSV は空の textlog(壊れてはいない)', () => {
    expect(parseTextlogCsv(HEADER)).toEqual({ entries: [], skippedRows: 0 });
    expect(parseTextlogCsv(HEADER + '\r\n')).toEqual({ entries: [], skippedRows: 0 });
  });

  it('CRLF / 素の LF のどちらでも読む', () => {
    const lf = [HEADER, row('l1', 'ts', 'd', 'false', 'a', '', '', '')].join('\n');
    expect(parseTextlogCsv(lf).entries).toHaveLength(1);
  });

  it('短い行(列が足りない)でも落ちない', () => {
    const got = parseTextlogCsv([HEADER, '"l1","ts"'].join('\r\n'));
    expect(got.entries[0]).toEqual({ id: 'l1', text: '', createdAt: 'ts', flags: [] });
  });

  it('空 / 必須列欠けは理由付きで断る(黙って 0 件にしない)', () => {
    expect(() => parseTextlogCsv('')).toThrow(TextlogCsvError);
    expect(() => parseTextlogCsv('"log_id","timestamp_iso"')).toThrow(/必須列/);
    expect(() => parseTextlogCsv('"a","b","c"')).toThrow(/必須列/);
  });
});
