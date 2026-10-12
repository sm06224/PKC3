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
  checkImageParts,
  chooseImage,
  decodeImageParts,
  groupAssetParts,
  IMAGE_PART_BYTES,
  IMAGE_PART_CHARS,
  imagePartMark,
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

describe('DB 画像を割った要素の印 (#1416 §7-4)', () => {
  const marks = (n: number): string[] => Array.from({ length: n }, (_, i) => imagePartMark(i, n));

  it('揃っていれば null(1 要素・複数要素・割る前の版の 1 本物)', () => {
    expect(checkImageParts([])).toBeNull();
    expect(checkImageParts([''])).toBeNull(); // 割る前の版
    expect(checkImageParts(marks(1))).toBeNull();
    expect(checkImageParts(marks(5))).toBeNull();
  });

  it('🔴 欠け・重複・順の乱れ・総数の食い違い・形の違いは理由を返す(黙って繋がない)', () => {
    const m = marks(4);
    const bad: Record<string, string[]> = {
      途中が欠けた: [m[0]!, m[1]!, m[3]!],
      末尾が欠けた: m.slice(0, 3),
      先頭が欠けた: m.slice(1),
      重複: [m[0]!, m[1]!, m[1]!, m[3]!],
      順が乱れた: [m[0]!, m[2]!, m[1]!, m[3]!],
      総数が違う: [imagePartMark(0, 2), imagePartMark(1, 3)],
      割る前の版が2本: ['', ''],
      割る前の版が割った版に混ざる: ['', m[1]!],
      形が違う: ['a/b', 'c'],
    };
    for (const [name, v] of Object.entries(bad)) {
      const why = checkImageParts(v);
      expect(why, name).not.toBeNull();
      expect(why, name).toContain('番号が合いません');
    }
  });
});

describe('割った DB 画像を 1 本へ直に復号する (#1416 §7-4)', () => {
  const b64 = (bytes: Uint8Array): string => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin);
  };
  const fill = (n: number, seed: number): Uint8Array => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 255;
    return a;
  };

  it('🔴 割る単位は 3 の倍数(各要素を独立に復号できる)で、16MiB 以下(64MB で二乗が戻る実測)', () => {
    expect(IMAGE_PART_BYTES % 3).toBe(0);
    expect(IMAGE_PART_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(IMAGE_PART_BYTES).toBeGreaterThan(0);
    expect(IMAGE_PART_CHARS).toBe((IMAGE_PART_BYTES / 3) * 4);
  });

  it('3 要素(最後に端数)を 1 バイトも違わず 1 本へ復号し、読み口は 1 回ずつ呼ぶ', () => {
    const a = fill(IMAGE_PART_BYTES, 1);
    const b = fill(IMAGE_PART_BYTES, 2);
    const c = fill(7, 3); // 端数 → `=` が出る
    const calls: number[] = [];
    const texts = [b64(a), b64(b), b64(c)];
    expect(texts[2]).toContain('=');
    const got = decodeImageParts(
      texts.map((t, i) => () => {
        calls.push(i);
        return t;
      }),
    )!;
    expect(got.byteLength).toBe(IMAGE_PART_BYTES * 2 + 7);
    expect(got.subarray(0, IMAGE_PART_BYTES).every((v, i) => v === a[i])).toBe(true);
    expect(got.subarray(IMAGE_PART_BYTES, IMAGE_PART_BYTES * 2).every((v, i) => v === b[i])).toBe(true);
    expect(Array.from(got.subarray(IMAGE_PART_BYTES * 2))).toEqual(Array.from(c));
    expect([...calls].sort()).toEqual([0, 1, 2]);
    // 一度に総 bytes ちょうどの 1 本(余りの無い buffer = 後で切り詰める複製が要らない)
    expect(got.buffer.byteLength).toBe(got.byteLength);
  });

  it('🔴 途中の要素が短い・長いと、黙って詰めず理由で断る(後ろが前へずれて別の画像になる)', () => {
    const full = b64(fill(IMAGE_PART_BYTES, 1));
    const tail = b64(fill(10, 3));
    const short = b64(fill(IMAGE_PART_BYTES - 3, 2));
    const long = b64(fill(IMAGE_PART_BYTES + 3, 2));
    expect(() => decodeImageParts([() => full, () => short, () => tail])).toThrow(/2 個目が途中で欠けています/);
    expect(() => decodeImageParts([() => short, () => full, () => tail])).toThrow(/1 個目が途中で欠けています/);
    expect(() => decodeImageParts([() => full, () => long, () => tail])).toThrow(/2 個目/);
    // 対照: ちょうどなら通る
    expect(decodeImageParts([() => full, () => full, () => tail])!.byteLength).toBe(IMAGE_PART_BYTES * 2 + 10);
  });

  it('空・1 本物・空白混じり', () => {
    expect(decodeImageParts([])).toBeNull();
    expect(decodeImageParts([() => '  \n'])).toBeNull(); // 割る前の版の空
    expect(() => decodeImageParts([() => b64(fill(IMAGE_PART_BYTES, 1)), () => ' '])).toThrow(/空の部分/);
    const one = fill(1000, 5);
    const spaced = b64(one).replace(/(.{76})/g, '$1\n') + ' \n';
    expect(Array.from(decodeImageParts([() => spaced])!)).toEqual(Array.from(one));
  });
});

describe('添付の要素を 1 件ずつの塊にする (#1416 §7-4d)', () => {
  const m = (n: number): string[] => Array.from({ length: n }, (_, i) => imagePartMark(i, n));
  const items = (key: string, marks: string[]) => marks.map((mark) => ({ key, mark }));

  it('割る前の版(印なし)は 1 要素 = 1 件。割った版は同じ key の続きが 1 件', () => {
    const all = [...items('a', ['']), ...items('b', m(3)), ...items('c', ['']), ...items('d', m(1))];
    expect(groupAssetParts(all)).toEqual([
      { start: 0, count: 1, broken: null },
      { start: 1, count: 3, broken: null },
      { start: 4, count: 1, broken: null },
      { start: 5, count: 1, broken: null },
    ]);
    expect(groupAssetParts([])).toEqual([]);
  });

  it('🔴 総数を超えた余りの要素は、黙って受けず断る', () => {
    const extra = groupAssetParts(items('a', [...m(2), imagePartMark(1, 2)]));
    expect(extra[0]!.broken).toBeNull();
    expect(extra[1]!.broken, '余りの要素を黙って受けている').not.toBeNull();
  });

  it('🔴 欠け・順の乱れ・先頭が 0 でない・総数まで届かない は理由を返し、key を名指しする', () => {
    const mm = m(4);
    const cases: Record<string, string[]> = {
      途中が欠けた: [mm[0]!, mm[1]!, mm[3]!],
      末尾が欠けた: mm.slice(0, 3),
      先頭が欠けた: mm.slice(1),
      順が乱れた: [mm[0]!, mm[2]!, mm[1]!, mm[3]!],
    };
    for (const [name, marks] of Object.entries(cases)) {
      const g = groupAssetParts(items('ast-x', marks));
      expect(
        g.some((x) => x.broken !== null && x.broken.includes('添付「ast-x」')),
        name,
      ).toBe(true);
    }
  });

  it('別の key の要素は、同じ塊に入れない', () => {
    const g = groupAssetParts([...items('a', ['0/2']), ...items('b', ['1/2'])]);
    expect(g.every((x) => x.broken !== null)).toBe(true);
  });
});

describe('復号の断り文の名前 (#1416 §7-4d)', () => {
  it('label を渡すと、断り文は添付の名前で言う(DB の中身と言わない)', () => {
    const full = 'A'.repeat((IMAGE_PART_BYTES / 3) * 4);
    expect(() => decodeImageParts([() => full.slice(4), () => 'AAAA'], '添付「x」の中身')).toThrow(
      /添付「x」の中身の 1 個目が途中で欠けています/,
    );
    expect(() => decodeImageParts([() => full.slice(4), () => 'AAAA'])).toThrow(/DB の中身の 1 個目/);
  });
});
