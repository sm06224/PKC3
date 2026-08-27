/**
 * 🔴 **写真を縮めるかどうかの判断**(#412)。
 *
 * ⚠ ここは**純関数だけ**。実際に縮めるのはワーカー(`asset-codec`)で、
 *   繋がりは `tests/adapter/attach-shrink.test.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  SHRINK_MAX_EDGE,
  SHRINK_MIN_BYTES,
  shrinkPlan,
  shrinkQuestion,
  worthShrinking,
} from '../../src/features/asset/image-shrink';

const BIG = SHRINK_MIN_BYTES * 4;

describe('縮める判断(#412)', () => {
  describe('縮める', () => {
    it('🔴 大きい写真は、長辺 2048 に収まるよう縮める(縦横比を保つ)', () => {
      const p = shrinkPlan('image/jpeg', BIG, 4000, 3000)!;
      expect(p.width).toBe(SHRINK_MAX_EDGE);
      // ⚠ 縦横比 ── 3000 × (2048/4000) = 1536
      expect(p.height).toBe(1536);
    });

    it('縦長でも長辺で決まる', () => {
      const p = shrinkPlan('image/jpeg', BIG, 3000, 4000)!;
      expect(p.height).toBe(SHRINK_MAX_EDGE);
      expect(p.width).toBe(1536);
    });

    it('🔴 形式は変えない(PNG の透過を黙って落とさない)', () => {
      expect(shrinkPlan('image/png', BIG, 4000, 3000)!.mime).toBe('image/png');
      expect(shrinkPlan('image/webp', BIG, 4000, 3000)!.mime).toBe('image/webp');
    });

    it('⚠ 極端に細長くても 1px を下回らない', () => {
      const p = shrinkPlan('image/jpeg', BIG, 40000, 3)!;
      expect(p.width).toBe(SHRINK_MAX_EDGE);
      expect(p.height).toBeGreaterThanOrEqual(1);
    });
  });

  describe('🔴 触らない', () => {
    it('小さい画像は聞きもしない(確認が邪魔なだけの機構にしない)', () => {
      expect(shrinkPlan('image/jpeg', SHRINK_MIN_BYTES - 1, 4000, 3000)).toBeNull();
    });

    it('🔑 対照群 ── 同じ画素数でも大きければ縮める', () => {
      expect(shrinkPlan('image/jpeg', SHRINK_MIN_BYTES, 4000, 3000)).not.toBeNull();
    });

    it('長辺が既に 2048 以下なら縮めない(画質だけ落ちる)', () => {
      expect(shrinkPlan('image/jpeg', BIG, SHRINK_MAX_EDGE, 100)).toBeNull();
    });

    it('🔑 対照群 ── 1px 大きければ縮める', () => {
      expect(shrinkPlan('image/jpeg', BIG, SHRINK_MAX_EDGE + 1, 100)).not.toBeNull();
    });

    it('🔴 画素が読めなかったものは触らない(壊れた画像を壊し直さない)', () => {
      expect(shrinkPlan('image/jpeg', BIG, 0, 0)).toBeNull();
      expect(shrinkPlan('image/jpeg', BIG, -1, 3000)).toBeNull();
    });

    it('🔴 SVG と GIF は触らない(画素ではない / 動く)', () => {
      expect(shrinkPlan('image/svg+xml', BIG, 4000, 3000)).toBeNull();
      expect(shrinkPlan('image/gif', BIG, 4000, 3000)).toBeNull();
    });

    it('画像でないものは触らない', () => {
      expect(shrinkPlan('application/pdf', BIG, 4000, 3000)).toBeNull();
    });
  });

  describe('🔴 縮めた結果を採るか', () => {
    it('十分小さくなったら採る', () => {
      expect(worthShrinking(1000, 500)).toBe(true);
    });

    it('🔴 ほとんど変わらないなら採らない', () => {
      expect(worthShrinking(1000, 900)).toBe(false);
    });

    it('🔴 増えたなら採らない(聞いておいて増えるのが最悪)', () => {
      // ⚠ PNG のスクショを再符号化すると実際に増えることがある
      expect(worthShrinking(1000, 1200)).toBe(false);
    });
  });

  describe('聞く文言', () => {
    it('🔴 本当の数字が両方出る(画素数と大きさ)', () => {
      const q = shrinkQuestion(
        { width: 4000, height: 3000, bytes: 12 * 1024 * 1024 },
        { width: 2048, height: 1536, bytes: 1.4 * 1024 * 1024 },
      );
      expect(q).toContain('4000×3000');
      expect(q).toContain('2048×1536');
      expect(q).toContain('12.0 MB');
      expect(q).toContain('1.4 MB');
      // 🔴 **戻せないことを言う**(不可逆な操作なので)
      expect(q, '戻せないことを言っていない').toContain('戻りません');
    });
  });
});
