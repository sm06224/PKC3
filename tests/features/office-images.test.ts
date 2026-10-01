/**
 * 🔴 Office「挿入 → 画像」に並べる添付を**選ぶ**(#146 裁定 A)。
 *
 * 守る主張:
 *  ① **画像だけ**を選ぶ(docx / zip / 空の添付は置かない)
 *  ② **合計の上限を超えたら、大きい物から外す**(小さい画像を多く残す)── 外した件数は数える
 *  ③ 上限に収まるなら**何も外さない**(対照群)
 *  ④ 元の名前のまま置く(拡張子が無いときだけ MIME から足す)
 *  ⑤ 外した件数を言う 1 行は、使わない語(`ui-terms.ts`)を含まない
 */
import { describe, expect, it } from 'vitest';
import {
  OFFICE_IMAGE_BUDGET_BYTES,
  isOfficeImageMime,
  officeImageFileName,
  pickOfficeImages,
  skippedImagesNotice,
  type OfficeImageCandidate,
} from '../../src/features/office/office-images';
import { BANNED_TERMS } from '../../src/features/ui-terms';

const MB = 1024 * 1024;
const img = (key: string, size: number, mime = 'image/png', name = `${key}.png`): OfficeImageCandidate => ({
  key,
  name,
  mime,
  size,
});

describe('並べてよい画像', () => {
  it('png / jpeg / gif / webp / svg / bmp だけ(付き物があっても)', () => {
    for (const m of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/bmp',
      'IMAGE/PNG',
      'image/png; charset=binary',
    ]) {
      expect(isOfficeImageMime(m), m).toBe(true);
    }
    // 🔑 `image/*` 全部ではない。⚠ 画像でない物と、Qt の一覧に出ない画像を置かない
    for (const m of ['image/tiff', 'application/pdf', 'application/zip', 'text/plain', '', 'application/octet-stream']) {
      expect(isOfficeImageMime(m), m).toBe(false);
    }
  });

  it('🔴 画像でない添付は置かず、「並べなかった件数」にも数えない', () => {
    const r = pickOfficeImages([
      img('a', 10),
      img('doc', 10, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x.docx'),
      img('z', 10, 'application/zip', 'x.zip'),
    ]);
    expect(r.picked.map((c) => c.key)).toEqual(['a']);
    expect(r.skipped, '画像でない物は「並べる対象」ではない').toBe(0);
  });

  it('0 バイトの添付は置かない(空の file を一覧に出さない)', () => {
    expect(pickOfficeImages([img('e', 0), img('a', 5)]).picked.map((c) => c.key)).toEqual(['a']);
  });

  it('候補が 0 件なら何も置かない', () => {
    expect(pickOfficeImages([])).toEqual({ picked: [], skipped: 0 });
  });
});

describe('合計の上限', () => {
  it('上限は 64 MB(出発点。変えたらここと注釈の理由を一緒に見直す)', () => {
    expect(OFFICE_IMAGE_BUDGET_BYTES).toBe(64 * MB);
  });

  it('🔴 上限を超えたら、大きい物から外す(小さい画像が残る / 元の並びのまま)', () => {
    const r = pickOfficeImages(
      [img('s1', 10 * MB), img('big', 50 * MB), img('s2', 20 * MB), img('s3', 10 * MB)],
      64 * MB,
    );
    // 合計 90 → big(50)を外して 40 で収まる
    expect(r.picked.map((c) => c.key)).toEqual(['s1', 's2', 's3']);
    expect(r.skipped).toBe(1);
  });

  it('🔴 1 件外しても収まらなければ、収まるまで大きい順に外し続ける', () => {
    const r = pickOfficeImages([img('a', 40 * MB), img('b', 30 * MB), img('c', 20 * MB), img('d', 10 * MB)], 64 * MB);
    // 100 → a(40)を外して 60 ≤ 64
    expect(r.picked.map((c) => c.key)).toEqual(['b', 'c', 'd']);
    const r2 = pickOfficeImages([img('a', 40 * MB), img('b', 38 * MB), img('c', 20 * MB), img('d', 10 * MB)], 64 * MB);
    // 108 → a を外して 68 > 64 → b(38)も外して 30
    expect(r2.picked.map((c) => c.key)).toEqual(['c', 'd']);
    expect(r2.skipped).toBe(2);
  });

  it('1 枚だけで上限を超える画像は置かない(全部が落ちて 0 件でもよい)', () => {
    const r = pickOfficeImages([img('huge', 70 * MB)], 64 * MB);
    expect(r.picked).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('🔴 対照群:ちょうど上限なら 1 枚も外さない', () => {
    const r = pickOfficeImages([img('a', 32 * MB), img('b', 32 * MB)], 64 * MB);
    expect(r.picked.length, '空振り防止(件数 > 0)').toBe(2);
    expect(r.skipped).toBe(0);
  });

  it('大きさが同じなら後ろから外す(順序が決まっている)', () => {
    const r = pickOfficeImages([img('a', 40 * MB), img('b', 40 * MB)], 64 * MB);
    expect(r.picked.map((c) => c.key)).toEqual(['a']);
  });

  it('既定の上限は OFFICE_IMAGE_BUDGET_BYTES(引数を省いても効く)', () => {
    const r = pickOfficeImages([img('a', 40 * MB), img('b', 40 * MB)]);
    expect(r.skipped).toBe(1);
  });
});

describe('置く名前', () => {
  it('元の名前のまま(日本語・空白もそのまま)', () => {
    expect(officeImageFileName({ name: '猫の 写真.png', mime: 'image/png', key: 'ast-1' })).toBe('猫の 写真.png');
    expect(officeImageFileName({ name: 'A.JPEG', mime: 'image/jpeg', key: 'ast-1' })).toBe('A.JPEG');
  });

  it('🔴 拡張子が無い名前には MIME から足す(Qt の一覧は拡張子で絞るので、無いと出ない)', () => {
    expect(officeImageFileName({ name: 'scan', mime: 'image/jpeg', key: 'ast-1' })).toBe('scan.jpg');
    expect(officeImageFileName({ name: 'logo', mime: 'image/svg+xml', key: 'ast-1' })).toBe('logo.svg');
  });

  it('名前が空なら key の頭から作る', () => {
    expect(officeImageFileName({ name: '  ', mime: 'image/png', key: 'ast-abcdef123' })).toBe('image-ast-abcd.png');
  });
});

describe('置かなかった件数を言う 1 行', () => {
  it('0 件なら言わない', () => {
    expect(skippedImagesNotice(0)).toBe('');
    expect(skippedImagesNotice(0, 0)).toBe('');
  });

  it('上限の話は件数と上限を言う', () => {
    const t = skippedImagesNotice(3);
    expect(t).toContain('3 件');
    expect(t).toContain('64.0 MB');
    expect(t).toContain('挿入 → 画像');
  });

  it('読めなかった分は別の文で言い、上限の話に混ぜない', () => {
    const t = skippedImagesNotice(0, 2);
    expect(t).toContain('読めなかった');
    expect(t).toContain('2 件');
    expect(t, '読めなかっただけの回に上限の話をしない').not.toContain('64.0 MB');
  });

  it('🔴 使わない語(ui-terms の BANNED_TERMS)を含まない', () => {
    // 空振り防止 ── 表が空なら何も検めていない / 検めの正規表現が本当に当たる(対照群)
    expect(BANNED_TERMS.length).toBeGreaterThan(0);
    expect(BANNED_TERMS.some((b) => b.pattern().test('器を使う')), '対照群:禁止語に当たる').toBe(true);
    for (const t of [skippedImagesNotice(3), skippedImagesNotice(1, 2)]) {
      expect(t).not.toBe('');
      for (const b of BANNED_TERMS) {
        expect(b.pattern().test(t), `「${b.banned}」が入っている: ${t}`).toBe(false);
      }
    }
  });
});
