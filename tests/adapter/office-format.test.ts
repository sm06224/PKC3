/** @vitest-environment happy-dom */
/**
 * 🔴 **この形式は、この Office で保存できるか**(#225)。
 *
 * 実測(2026-08-23、同じ本文から作った 4 つを同じ腕で):
 *
 * | 形式 | Ctrl+S の後 | |
 * |---|---|---|
 * | `.odt` | 8,289 → **9,192 B** | ✅ |
 * | `.rtf` / `.doc` / `.docx` | 変わらず | 🔴 「一般的な I/O エラー」 |
 *
 * 🔑 分かれ目は**書式の種類ではなく ODF かどうか**である。
 *
 * ⚠ `public/office/office-format.js` は **bundle されない素の JS**(`host.html` が
 * `<script src>` で読む)。`readFileSync` + `new Function` で読み込んで当てる ──
 * これをやらないと、この判断は**どの test からも実行されない**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isOfficeAttachment } from '../../src/features/office/office-entry';

interface Api {
  SAVABLE_EXTS: string[];
  extOf(name: unknown): string;
  isSavable(name: unknown): boolean;
}

function load(): Api {
  const src = readFileSync('public/office/office-format.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeFormat as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const api = load();

describe('保存できる形式', () => {
  it('🔴 ODF の 4 つだけ(等値 pin ── 足すなら測ってから)', () => {
    // ⚠ 等値で pin する ── 「1 件以上ある」では、こっそり増えたのを検出できない。
    //    🔑 **4 つとも実測済み**(.odt 8,289→9,192 / .ods 8,991→9,676 /
    //    .odp 841→11,452 / .odg 12,401→13,447)。
    //    ⚠ 増やすには実測が要る(この list に入れる = user へ「保存できます」と言うこと)
    expect(api.SAVABLE_EXTS).toEqual(['.odt', '.ods', '.odp', '.odg']);
  });

  it('ODF は保存できる / 非 ODF は保存できない', () => {
    for (const ok of ['a.odt', 'a.ods', 'a.odp', 'a.odg']) {
      expect(api.isSavable(ok), `${ok} を保存できないと言っている`).toBe(true);
    }
    // 🔑 **5 つとも実測済み**(.rtf / .doc / .docx / .xlsx は「一般的な I/O エラー」、
    //    .pptx は小窓すら出ずに黙って保存されない)。旧形式 .xls / .ppt は同じ側
    for (const ng of ['a.docx', 'a.doc', 'a.rtf', 'a.xlsx', 'a.xls', 'a.pptx', 'a.ppt']) {
      expect(api.isSavable(ng), `${ng} を保存できると言っている`).toBe(false);
    }
  });

  it('🔴 flat ODF は「保存できる」側に入れていない(未実測だから)', () => {
    // ⚠ `.fodt` は 1 枚の XML で、パッケージ格納形式ではない ── 分かれ目の
    //    どちら側かを測っていない。「できる」と言って失うほうが痛いので偽にする
    for (const flat of ['a.fodt', 'a.fods', 'a.fodp']) {
      expect(api.isSavable(flat), `${flat} を測らずに保存できると言っている`).toBe(false);
    }
  });

  it('🔴 名前が無い / 拡張子が無いときは断らない(窓の中の新規は ODF になる)', () => {
    // ⚠ ここを false にすると、窓の中で新規に作った文書に「保存できません」と
    //    出る ── **嘘**である(既定は ODF なので保存できる)
    expect(api.isSavable('')).toBe(true);
    expect(api.isSavable('無題 1')).toBe(true);
    expect(api.isSavable(null)).toBe(true);
    expect(api.isSavable(undefined)).toBe(true);
  });

  it('大文字・前後の空白で取り違えない', () => {
    expect(api.isSavable('  A.ODT  ')).toBe(true);
    expect(api.isSavable('A.DOCX')).toBe(false);
    expect(api.extOf('x/y/報告.Odt')).toBe('.odt');
    expect(api.extOf('拡張子なし')).toBe('');
  });
});

/**
 * 🔴 **2 つの判定は別物である**(CLAUDE.md「誤差の向きを決めて、両側に使い回さない」)。
 *
 * - `isOfficeAttachment` … 「Office で開くボタンを出すか」= **取りこぼしが痛い**ので広く拾う
 * - `isSavable` … 「保存できると言ってよいか」= **嘘が痛い**ので狭く当てる
 *
 * 🔑 だから **`isSavable` ⊂ `isOfficeAttachment`** でなければならない ──
 * 保存できると言っておいて入口が無い、は矛盾である。
 */
describe('入口の判定との関係', () => {
  it('🔴 保存できると言う形式は、必ず入口も出している', () => {
    for (const ext of api.SAVABLE_EXTS) {
      expect(
        isOfficeAttachment('', `a${ext}`),
        `${ext} は保存できると言っているのに Office の入口が無い`,
      ).toBe(true);
    }
  });

  it('🔴 逆は成り立たない(入口のほうが広い)── 広いことを実際に確かめる', () => {
    // ⚠ 空振り防止 ── 「入口は出すが保存はできない」形式が**実在する**こと。
    //    ここが 0 件なら、2 つの判定を分けた意味がそもそも無い
    const wider = ['a.docx', 'a.xlsx', 'a.pptx', 'a.doc', 'a.xls', 'a.ppt', 'a.rtf'].filter(
      (n) => isOfficeAttachment('', n) && !api.isSavable(n),
    );
    expect(wider.length, '入口と保存の広さが同じ ── 分けた意味が無い').toBeGreaterThan(0);
  });
});
