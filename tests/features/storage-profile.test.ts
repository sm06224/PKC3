/**
 * 🔴 **何が容量を食っているか**(#415)── 並べ方と文言。
 *
 * 数える側は `tests/adapter/storage-worker.test.ts`(実物の worker)が見る。
 * ここで見るのは **user が読む形**:重い順か / 0 B の行を並べないか /
 * 「合わない」と読まれない言い方になっているか。
 */
import { describe, it, expect } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  PROFILE_TOP,
  profileLineText,
  profileLines,
  profileSummary,
  sharedNote,
  type StorageProfileResult,
} from '../../src/features/storage/storage-profile';

const meta = (lid: string, title: string): EntryMeta =>
  ({ lid, title, archetype: 'text', entryOrder: 0, archived: false }) as EntryMeta;

const row = (lid: string, assetBytes: number, bodyChars = 0, sharedAssets = 0) => ({
  lid,
  assetBytes,
  bodyChars,
  sharedAssets,
});

const result = (
  rows: ReturnType<typeof row>[],
  over: Partial<StorageProfileResult> = {},
): StorageProfileResult => ({
  rows,
  totalAssetBytes: rows.reduce((n, r) => n + r.assetBytes, 0),
  orphanBytes: 0,
  ...over,
});

const metas = new Map([
  ['a', meta('a', '写真たくさん')],
  ['b', meta('b', '軽いノート')],
  ['c', meta('c', '長い文章')],
]);

describe('並べ方', () => {
  it('🔴 **重い順**', () => {
    /**
     * ⚠ **他の鍵が救わない形にする**(変異試験 S1 が SURVIVED で教えた)。
     *   `assetBytes` を外しても、次の鍵(`bodyChars` → `lid`)が同じ順を出すなら
     *   この it は何も見ていない ── §1「救い手が変わっただけ」。
     * 🔑 だから重いほうを **本文は短く / lid は後ろ**にする:
     *   - `assetBytes` で並べる → `z`(重い)が先 ✅
     *   - `bodyChars` で並べる → `b`(本文 900)が先 ❌
     *   - `lid` で並べる → `b` が先 ❌
     */
    const m = new Map([
      ['z', meta('z', '重いが短い')],
      ['b', meta('b', '軽いが長い')],
    ]);
    const l = profileLines(result([row('b', 1000, 900), row('z', 5_000_000, 1)]), m);
    expect(l.map((x) => x.lid), '添付の大きさで並べていない').toEqual(['z', 'b']);
  });

  it('🔴 添付も本文も 0 の行は出さない(0 B を 280 本見せない)', () => {
    const l = profileLines(result([row('a', 5000), row('b', 0, 0)]), metas);
    expect(l.map((x) => x.lid)).toEqual(['a']);
  });

  it('⚠ 添付が 0 でも**本文が長ければ**出す(本文も容量である)', () => {
    const l = profileLines(result([row('c', 0, 9000)]), metas);
    expect(l.map((x) => x.lid), '本文の重い行を落とした').toEqual(['c']);
  });

  it('🔴 題名が引けない lid は落とす(押しても飛べない行を出さない)', () => {
    const l = profileLines(result([row('zzz', 9_000_000), row('a', 1000)]), metas);
    expect(l.map((x) => x.lid)).toEqual(['a']);
  });

  it('🔴 並びが毎回同じ(同じ大きさなら本文 → lid で決める)', () => {
    /**
     * ⚠ ばらばらの順で出ると、押す場所を覚えられない。
     */
    const r = result([row('b', 100, 5), row('a', 100, 5), row('c', 100, 9)]);
    expect(profileLines(r, metas).map((x) => x.lid)).toEqual(['c', 'a', 'b']);
    // 2 回呼んでも同じ
    expect(profileLines(r, metas).map((x) => x.lid)).toEqual(['c', 'a', 'b']);
  });

  it(`上から ${PROFILE_TOP} 本まで`, () => {
    const many = Array.from({ length: PROFILE_TOP + 10 }, (_, i) => row(`x${i}`, 1000 + i));
    const m = new Map(many.map((r) => [r.lid, meta(r.lid, r.lid)]));
    expect(profileLines(result(many), m)).toHaveLength(PROFILE_TOP);
  });

  it('共有している行に印が付く', () => {
    const l = profileLines(result([row('a', 100, 0, 2)]), metas);
    expect(l[0]!.shared).toBe(true);
    expect(profileLines(result([row('a', 100, 0, 0)]), metas)[0]!.shared).toBe(false);
  });
});

describe('大きさの見せ方', () => {
  // ⚠ **形そのもの**(`512 B` / `2.0 KB`)は `tests/features/human-bytes.test.ts` が
  //    見る(#454 で 1 本に寄せた)── ここで二重に pin すると、寄せ先を直したとき
  //    **2 か所を直す羽目になる**(それが 4 本に増えた道筋である)。

  it('行は「大きさ → 題名」の順(目で追うのは大きさ)', () => {
    const [l] = profileLines(result([row('a', 5_000_000)]), metas);
    expect(profileLineText(l!)).toMatch(/^4\.8 MB\s+写真たくさん$/);
  });

  it('共有している行は、その旨が字に出る', () => {
    const [l] = profileLines(result([row('a', 100, 0, 1)]), metas);
    expect(profileLineText(l!)).toContain('共有');
  });
});

/**
 * 🔴 **「合わない」と読まれない言い方**(#415 の ⚠)。
 * ⚠ ブラウザが言う使用量は索引や空き領域も数えるので、こちらの合計とは一致しない。
 */
describe('合計の言い方', () => {
  it('🔴 何を数えているかを必ず言う', () => {
    const s = profileSummary(result([row('a', 1024)]));
    expect(s, 'ブラウザの使用量と混同される').toContain('数え方が違います');
    expect(s).toContain('添付');
  });

  it('孤児が在れば、片づけられることまで言う', () => {
    const s = profileSummary(result([row('a', 1024)], { orphanBytes: 2048 }));
    expect(s).toContain('使われていません');
    expect(s, '片づけ方が書いていない').toContain('使っていない添付を消す');
  });

  it('⚠ 孤児が無いときは、その話をしない(要らない注意書きを出さない)', () => {
    expect(profileSummary(result([row('a', 1024)]))).not.toContain('使われていません');
  });

  it('⚠ 共有が無いときは但し書きを出さない', () => {
    expect(sharedNote(profileLines(result([row('a', 100)]), metas))).toBe('');
  });

  it('🔴 共有が在れば「消しても減らない」と言う', () => {
    const n = sharedNote(profileLines(result([row('a', 100, 0, 1)]), metas));
    expect(n, '共有の意味が書いていない').toContain('減りません');
  });
});
