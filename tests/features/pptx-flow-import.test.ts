/** @vitest-environment node */
/**
 * PowerPoint の取り込み: 位置を持たない題名・本文の枠(#1163 依頼 124-1 = A)。
 *
 * 守る主張:
 * - 位置を持たない題名はノートの題名に、本文(箇条書きを含む)は板ではなく上から順の段落になる
 * - 日付・フッター・スライド番号の枠は黙って読み飛ばす(取り込めなかった数に入れない)
 * - 図・表の枠(位置を持たない)と、枠の種類が分からないものは今までどおり「取り込めなかった」に数える
 * - 位置を持つ図形(今までの板)は今までどおり付箋になる(対照群)
 */
import { describe, expect, it } from 'vitest';
import { readPptxSlide } from '../../src/features/import/pptx-board';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slide = (shapes: string): string =>
  `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
const para = (t: string, bullet = false): string =>
  `<a:p>${bullet ? '<a:pPr><a:buChar char="•"/></a:pPr>' : ''}<a:r><a:rPr lang="ja-JP"/><a:t>${t}</a:t></a:r></a:p>`;
/** 位置を持たない枠(`<p:spPr/>` が空 ── レイアウトから借りる)。 */
const ph = (id: number, type: string | null, paras: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="x${id}"/><p:cNvSpPr/><p:nvPr><p:ph${type === null ? '' : ` type="${type}"`}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:endParaRPr/></a:p>${paras}</p:txBody></p:sp>`;
const placed = (id: number, text: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="付箋${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="9525" y="9525"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr><p:txBody><a:bodyPr/>${para(text)}</p:txBody></p:sp>`;

describe('位置を持たない題名・本文の枠', () => {
  it('🔴 題名はノートの題名、本文は段落(箇条書きは続く)。1 枚もノートにならない、は起きない', () => {
    const s = readPptxSlide(
      slide(
        ph(2, 'title', para('今期の方針')) +
          ph(3, 'body', para('最初の段落') + para('次の段落') + para('項目 1', true) + para('項目 2', true)),
      ),
    );
    expect(s.title).toBe('今期の方針');
    expect(s.flowed).toBe(1);
    expect(s.placed).toBe(0);
    expect(s.dropped, '取り込めなかった数に入れない').toBe(0);
    expect(s.body).toBe('最初の段落\n\n次の段落\n\n- 項目 1\n- 項目 2\n');
    expect(s.body, '板の塊にしない').not.toContain(':::');
  });

  it('🔴 日付・フッター・スライド番号の枠は黙って読み飛ばす', () => {
    const s = readPptxSlide(
      slide(
        ph(2, 'title', para('題')) +
          ph(3, 'dt', para('2026/10/17')) +
          ph(4, 'ftr', para('社外秘')) +
          ph(5, 'sldNum', para('1')),
      ),
    );
    expect(s.title).toBe('題');
    expect(s.body).toBe('');
    expect(s.dropped).toBe(0);
  });

  it('🔴 図・表の枠(位置が無い)と、枠の種類が分からないものは、今までどおり取り込めなかった数に入る', () => {
    const s = readPptxSlide(slide(ph(2, 'pic', '') + ph(3, 'tbl', '') + ph(4, 'weird', para('？'))));
    expect(s.dropped).toBe(3);
    expect(s.flowed).toBe(0);
  });

  it('字の無い枠(クリックして入力の空枠)は何も足さず、数えもしない', () => {
    const s = readPptxSlide(slide(ph(2, 'title', para('題')) + ph(3, 'body', '')));
    expect(s.flowed).toBe(0);
    expect(s.dropped).toBe(0);
    expect(s.body).toBe('');
  });

  it('対照: 位置を持つ付箋は今までどおり板の塊になる。本文の段落と一緒でも、段落が先に来る', () => {
    const board = readPptxSlide(slide(placed(2, 'メモ')));
    expect(board.placed).toBe(1);
    expect(board.flowed).toBe(0);
    expect(board.body).toContain(':::format{');
    const mixed = readPptxSlide(slide(ph(2, 'body', para('段落')) + placed(3, 'メモ')));
    expect(mixed.body.startsWith('段落\n\n:::format{')).toBe(true);
    expect(mixed).toMatchObject({ placed: 1, flowed: 1 });
  });
});
