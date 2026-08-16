/**
 * 🔴 **拡張子 ↔ MIME の対応が、取込側と書出し側で一致する**(2026-08-16、着地前
 * レビュー R11)。
 *
 * ⚠ この対応は **3 か所**に在る:
 *
 * | 場所 | 向き | 役目 |
 * |---|---|---|
 * | `attach.ts` の `EXT_MIME` | 拡張子 → MIME | OS が MIME を付けないとき / Office の窓から戻った bytes |
 * | `pkc3-markdown-zip.ts` の `EXT_BY_MIME` | MIME → 拡張子 | 書き出した file に名前を付ける |
 * | `office-entry.ts` の `OFFICE_MIMES` / `OFFICE_EXTS` | 判定 | 「Office で開く」を出すか |
 *
 * 🔑 **手写しの例を並べた test では、表ごと消す変異が生き延びる**(実際に生き延びた:
 * Office 10 種を `EXT_MIME` から全部消しても、既存 test は 1 つも鳴らなかった)。
 * だから**母集団を実装から採って全数**で回す。
 *
 * ⚠ 片方だけ直す変異を殺すのがここの仕事 ── 「PKC では開けるのに、書き出すと
 * 外で開けない(`.bin`)」が、まさにその形で出荷されていた。
 */
import { describe, expect, it } from 'vitest';
import { EXT_MIME, resolveMime } from '@adapter/ui/actions/attach';
import { extForMime } from '@features/export/pkc3-markdown-zip';
import { officeEntry } from '@features/office/office-entry';

const OK = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  jspi: true,
  decompressionStream: true,
} as const;

describe('拡張子 ↔ MIME の往復', () => {
  it('🔴 `EXT_MIME` の全項目が、書出し側で同じ拡張子に戻る', () => {
    // ⚠ 空振り防止 ── 表が空 / 極端に小さいと、この全数検査は何も見ていない
    expect(Object.keys(EXT_MIME).length, '表が小さすぎる ── 全数検査になっていない')
      .toBeGreaterThan(20);
    const broken: string[] = [];
    for (const [ext, mime] of Object.entries(EXT_MIME)) {
      const back = extForMime(mime);
      // ⚠ `jpg` / `jpeg` のように**複数の拡張子が同じ MIME**を指すものが在る。
      //    要求するのは「戻った拡張子も同じ MIME を指すこと」── 綴りの一致ではない
      if (EXT_MIME[back] !== mime) broken.push(`${ext} → ${mime} → ${back}`);
    }
    expect(broken, '書出し側の表に無い ── 書き出すと `.bin` になり外で開けない').toEqual([]);
  });

  it('🔴 Office の入口が出る拡張子は、全部 MIME を持っている', () => {
    // ⚠ 入口(`office-entry.ts`)の判定は**拡張子だけでも拾う**ので、
    //    「開くボタンは出るのに書き出すと `.bin`」が成立しうる ── そこを塞ぐ
    const missing: string[] = [];
    for (const ext of ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
      'odt', 'ods', 'odp', 'odg', 'fodt', 'fods', 'fodp', 'rtf']) {
      const entry = officeEntry({
        mime: 'application/octet-stream',
        fileName: `x.${ext}`,
        packInstalled: true,
        capability: OK,
      });
      // 空振り防止 ── 入口が出ないなら、この行は何も主張していない
      expect(entry.kind, `${ext}: Office の入口が出ない`).toBe('open');
      if (EXT_MIME[ext] === undefined) missing.push(ext);
      else if (extForMime(EXT_MIME[ext]) !== ext) missing.push(`${ext}(書出しが戻らない)`);
    }
    expect(missing, 'Office で開けるのに、名前を付けられない').toEqual([]);
  });

  it('🔴 Office の窓から戻った bytes(MIME 無し)は、名前から MIME が付く', () => {
    // ⚠ **これがこの表を足した理由**である ── 窓から戻るのは `File` ではないので
    //    `type` が無く、以前は全部 `application/octet-stream` に落ちていた
    expect(resolveMime('無題 1.odt', '')).toBe('application/vnd.oasis.opendocument.text');
    expect(resolveMime('報告書.docx', '')).toContain('wordprocessingml');
    expect(resolveMime('集計.xlsx', '')).toContain('spreadsheetml');
    // 宣言があればそちらが勝つ(既存の規約 ── 変えていない)
    expect(resolveMime('x.odt', 'text/plain')).toBe('text/plain');
  });
});
