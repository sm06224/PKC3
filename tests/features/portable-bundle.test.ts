/**
 * 🔴 **可搬単一 HTML の「どの器を使うか」**(#400 段③)。
 *
 * ⚠ ここが間違うと、症状は「**開いたら自分のノートが消えていた**」である ──
 * だから分岐を 1 本ずつ、**両方向**で見る(CLAUDE.md §2「分岐を書いたら、
 * 分岐の数だけ実際に走らせた記録を持つ」)。
 */
import { describe, expect, it } from 'vitest';
import {
  bundleChannelName,
  bundleDbName,
  bundleLockName,
  bundleSqliteName,
  chooseImage,
  isBundleId,
  parseBundleTag,
  type PortableBundle,
  type StoredImageMeta,
} from '../../src/features/portable/bundle';

const B: PortableBundle = { id: 'pkcb-2b1f9c04d7', exportedAt: 1_000 };

const stored = (over: Partial<StoredImageMeta> = {}): StoredImageMeta => ({
  bundleId: B.id,
  exportedAt: 1_000,
  savedAt: 2_000,
  bytes: 4_096,
  ...over,
});

describe('印を読む', () => {
  it('印が無い = 素の PKC3 ── 🔴 これが `null` である限り既存の経路は変わらない', () => {
    expect(parseBundleTag(null)).toBeNull();
    expect(parseBundleTag(undefined)).toBeNull();
    expect(parseBundleTag('')).toBeNull();
    expect(parseBundleTag('   ')).toBeNull();
  });

  it('壊れた印は「印が無い」と同じに畳む(落とさない)', () => {
    for (const bad of [
      '{',
      '[]',
      'null',
      '"文字列"',
      '{"exportedAt":1}', // id が無い
      '{"id":"pkcb-2b1f9c04d7"}', // 時刻が無い
      '{"id":"短い","exportedAt":1}',
      '{"id":"pkcb-2b1f9c04d7","exportedAt":"1"}',
      '{"id":"pkcb-2b1f9c04d7","exportedAt":-1}',
    ])
      expect(parseBundleTag(bad), bad).toBeNull();
    // ⚠ 空振り防止 ── 上の全部が null なのは「常に null」だからではない
    expect(parseBundleTag('{"id":"pkcb-2b1f9c04d7","exportedAt":1}')).toEqual({
      id: 'pkcb-2b1f9c04d7',
      exportedAt: 1,
    });
  });

  it('🔴 NaN / Infinity を通さない ── 通すと比較が黙って false になる', () => {
    // ⚠ JSON に NaN は書けないので、印を作る側が壊れた形を書いた場合を模す
    expect(parseBundleTag(JSON.stringify({ id: B.id, exportedAt: null }))).toBeNull();
    expect(isBundleId('')).toBe(false);
    expect(isBundleId('大文字ハ不可')).toBe(false);
    expect(isBundleId('-hyphen-start')).toBe(false);
    expect(isBundleId('x'.repeat(65))).toBe(false);
    expect(isBundleId('x'.repeat(64))).toBe(true);
  });
});

describe('名前空間 ── 🔴 `file://` では器も鍵も放送路も scheme 全体で 1 個', () => {
  it('4 つの名前が全部 id を含み、互いに違う', () => {
    const names = [
      bundleDbName(B.id),
      bundleLockName(B.id),
      bundleChannelName(B.id),
      bundleSqliteName(B.id),
    ];
    for (const n of names) expect(n).toContain(B.id);
    expect(new Set(names).size).toBe(4);
  });

  it('🔴 別の id なら 4 つとも別の名前になる ── 1 つでも共有すると互いを上書きする', () => {
    const other = 'pkcb-ffffffffff';
    for (const make of [bundleDbName, bundleLockName, bundleChannelName, bundleSqliteName])
      expect(make(B.id)).not.toBe(make(other));
  });

  it('⚠ sqlite の器の名前は素の PKC3(`pkc3`)と重ならない', () => {
    // 重なると、`https://` に置いた可搬バンドルが**その origin の本体の DB を開く**
    expect(bundleSqliteName(B.id)).not.toBe('pkc3');
  });
});

describe('どちらの中身を開くか', () => {
  it('器が空 → 配られた中身', () => {
    expect(chooseImage({ bundle: B, stored: null, embeddedBytes: 100 }).use).toBe('embedded');
  });

  it('器も配りものも無い → 新しく作る', () => {
    expect(chooseImage({ bundle: B, stored: null, embeddedBytes: 0 }).use).toBe('fresh');
  });

  it('🔴 器のほうが新しい → 器(= user の編集を上書きしない)', () => {
    const c = chooseImage({
      bundle: B,
      stored: stored({ savedAt: B.exportedAt + 1 }),
      embeddedBytes: 100,
    });
    expect(c.use).toBe('stored');
  });

  it('🔴 器に何も書いていないうちに新しい HTML を置き直した → 配られた中身', () => {
    // ⚠ この 1 行が無いと「更新した HTML を開いても古いまま」になる
    const c = chooseImage({
      bundle: B,
      stored: stored({ savedAt: B.exportedAt - 1 }),
      embeddedBytes: 100,
    });
    expect(c.use).toBe('embedded');
  });

  it('同時刻は器を優先する(境界 ── 上書きしない側へ倒す)', () => {
    expect(
      chooseImage({ bundle: B, stored: stored({ savedAt: B.exportedAt }), embeddedBytes: 100 })
        .use,
    ).toBe('stored');
  });

  it('🔴 0 バイトの器は採らない(書込が途中で落ちた残骸)', () => {
    expect(
      chooseImage({ bundle: B, stored: stored({ bytes: 0, savedAt: 9_999 }), embeddedBytes: 100 })
        .use,
    ).toBe('embedded');
    // 配りものも無ければ、空の残骸ではなく新しい器
    expect(
      chooseImage({ bundle: B, stored: stored({ bytes: 0, savedAt: 9_999 }), embeddedBytes: 0 })
        .use,
    ).toBe('fresh');
  });

  it('🔴 別のバンドルの記録なら、その上に書かない', () => {
    expect(
      chooseImage({
        bundle: B,
        stored: stored({ bundleId: 'pkcb-ffffffffff', savedAt: 9_999 }),
        embeddedBytes: 100,
      }).use,
    ).toBe('embedded');
  });

  it('配りものが無ければ器を開く(古くても、それしかない)', () => {
    expect(
      chooseImage({ bundle: B, stored: stored({ savedAt: 1 }), embeddedBytes: 0 }).use,
    ).toBe('stored');
  });

  it('⚠ どの答えにも理由が付く ── 状態行に出す文言が空にならない', () => {
    for (const c of [
      chooseImage({ bundle: B, stored: null, embeddedBytes: 0 }),
      chooseImage({ bundle: B, stored: null, embeddedBytes: 1 }),
      chooseImage({ bundle: B, stored: stored(), embeddedBytes: 1 }),
      chooseImage({ bundle: B, stored: stored({ savedAt: 1 }), embeddedBytes: 1 }),
      chooseImage({ bundle: B, stored: stored({ bytes: 0 }), embeddedBytes: 1 }),
      chooseImage({ bundle: B, stored: stored({ bundleId: 'pkcb-ffffffffff' }), embeddedBytes: 1 }),
    ])
      expect(c.why.length).toBeGreaterThan(4);
  });
});
