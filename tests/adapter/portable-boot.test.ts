/** @vitest-environment happy-dom */
/**
 * 🔴 **可搬単一 HTML の起動**(#400 段③)。
 *
 * ⚠ いちばん守るのは「**素の PKC3 では何も起きない**」である ── 印が無い限り
 * `null` を返す。ここが崩れると、可搬のために足した経路が**全 user の起動**へ漏れる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readBundle,
  resolvePortableStart,
  takeEmbeddedImage,
  IMAGE_SELECTOR,
} from '../../src/adapter/platform/portable-boot';
import type { DbImageStore } from '../../src/adapter/platform/storage/db-image-store';

const ID = 'pkcb-2b1f9c04d7';
const tag = (o: unknown) =>
  `<script type="application/json" data-pkc-bundle>${JSON.stringify(o)}</script>`;
const imageTag = (bytes: number[]) =>
  `<script type="application/octet-stream;base64" data-pkc-db-image>${btoa(
    String.fromCharCode(...bytes),
  )}</script>`;

/** 器の代役。⚠ **本物と同じ意味論**にする(読めない記録は投げる)。 */
function fakeStore(
  rec: { bundleId: string; exportedAt: number; savedAt: number; image: Uint8Array } | null,
  opts: { throwOnRead?: string } = {},
): DbImageStore {
  return {
    read: async () => {
      if (opts.throwOnRead) throw new Error(opts.throwOnRead);
      return rec === null ? null : { ...rec, bytes: rec.image.byteLength };
    },
    readMeta: async () => null,
    write: async () => undefined,
    close: () => undefined,
  } as unknown as DbImageStore;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('印を読む', () => {
  it('🔴 素の PKC3(印なし)では null ── 既存の起動は 1 バイトも変わらない', async () => {
    expect(readBundle(document)).toBeNull();
    expect(await resolvePortableStart(document, () => fakeStore(null))).toBeNull();
  });

  it('印があれば読む', () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    expect(readBundle(document)).toEqual({ id: ID, exportedAt: 5 });
  });

  it('壊れた印は「印なし」に畳む', () => {
    document.head.innerHTML = '<script type="application/json" data-pkc-bundle>{</script>';
    expect(readBundle(document)).toBeNull();
  });
});

describe('焼き込まれた画像', () => {
  it('🔴 取り出したら DOM から外す(base64 が document の寿命ぶん常駐しない)', () => {
    document.body.innerHTML = imageTag([1, 2, 3, 4]);
    expect(document.querySelector(IMAGE_SELECTOR)).not.toBeNull(); // 空振り防止
    const bytes = takeEmbeddedImage(document).image;
    expect(Array.from(bytes!)).toEqual([1, 2, 3, 4]);
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('壊れた base64 でも DOM から外す(読めない物を抱え続けない)', () => {
    document.body.innerHTML =
      '<script type="application/octet-stream;base64" data-pkc-db-image>@@@</script>';
    const r = takeEmbeddedImage(document);
    expect(r.image).toBeNull();
    expect(r.failure).toContain('読み取れない形');
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('印だけで画像が無い形も成り立つ(空の可搬バンドル)', () => {
    expect(takeEmbeddedImage(document)).toEqual({ image: null, failure: null });
  });

  it('空の画像は失敗ではない(いままでどおり「配りものは無かった」)', () => {
    document.body.innerHTML =
      '<script type="application/octet-stream;base64" data-pkc-db-image>  </script>';
    expect(takeEmbeddedImage(document)).toEqual({ image: null, failure: null });
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });
});

/**
 * 🔴 **読み戻せない 1 枚を、黙って「無かった」に畳まない**(#996)。
 *
 * ⚠ `textContent` の `RangeError` は happy-dom では再現できない(実際に 400MB を作らない)ので、
 *   **getter を差し替えて投げさせる**。大きさは `textContent` を読まずに、`childNodes` の
 *   Text node の `length` の合計で数える(HTML の読み手は長い字を複数の Text node に割る)。
 */
describe('🔴 焼き込みが読み戻せないとき(#996)', () => {
  const MIB = 1024 * 1024;
  /** `textContent` を読むと `RangeError` を投げる偽の `<script>`。⚠ 呼ばれた回数を返す。 */
  function installUnreadable(chunks: number[]): { reads: () => number } {
    document.body.innerHTML =
      '<script type="application/octet-stream;base64" data-pkc-db-image></script>';
    const el = document.querySelector(IMAGE_SELECTOR)!;
    let reads = 0;
    Object.defineProperty(el, 'textContent', {
      get() {
        reads++;
        throw new RangeError('Invalid string length');
      },
    });
    Object.defineProperty(el, 'childNodes', {
      get: () => chunks.map((length) => ({ nodeType: 3, length })),
    });
    return { reads: () => reads };
  }
  /** DB が `mib` MiB になる base64 の字数。 */
  const charsFor = (mib: number): number => (mib * MIB * 4) / 3;

  it('textContent が RangeError → 起動は落ちず、大きさと逃げ道を言い、要素は外れる', () => {
    // 合計 300 MiB の DB ぶん(Text node 2 つに割れている)
    const probe = installUnreadable([charsFor(300) / 2, charsFor(300) / 2]);
    const r = takeEmbeddedImage(document);
    expect(probe.reads(), '空振り防止: 偽の getter が呼ばれていない').toBeGreaterThan(0);
    expect(r.image).toBeNull();
    expect(r.failure).toContain('大きすぎて');
    expect(r.failure).toContain('約 300.0 MB');
    expect(r.failure).toContain('バックアップ');
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('大きさは Text node の合計(1 つ目だけでは数えない)', () => {
    // 1 つ目だけなら約 100 MB / 合計なら約 250.0 MB
    installUnreadable([charsFor(100), charsFor(150)]);
    expect(takeEmbeddedImage(document).failure).toContain('約 250.0 MB');
  });

  it('壊れた base64 → 「読み取れない形」(大きさの文ではない)', () => {
    document.body.innerHTML =
      '<script type="application/octet-stream;base64" data-pkc-db-image>@@@</script>';
    const r = takeEmbeddedImage(document);
    expect(r.failure).toContain('読み取れない形');
    expect(r.failure).not.toContain('大きすぎて');
  });

  describe('resolvePortableStart ── why に理由が載る', () => {
    const rec = { bundleId: ID, exportedAt: 5, savedAt: 99, image: new Uint8Array([7, 7]) };

    it('端末の記録が無い → 空で始め、「大きすぎて」と「空」が why に出る', async () => {
      document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
      const probe = installUnreadable([charsFor(10)]);
      const start = (await resolvePortableStart(document, () => fakeStore(null)))!;
      expect(probe.reads()).toBeGreaterThan(0);
      expect(start.choice.use).toBe('fresh');
      expect(start.image).toBeNull();
      expect(start.choice.why).toContain('大きすぎて');
      expect(start.choice.why).toContain('約 10.0 MB');
      expect(start.choice.why).toContain('空の状態で開きます');
      expect(start.embeddedFailure).toContain('大きすぎて');
    });

    it('端末の記録が在る → その記録で開き、「大きすぎて」と「この端末に保存された中身」が why に出る', async () => {
      document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
      installUnreadable([charsFor(10)]);
      const start = (await resolvePortableStart(document, () => fakeStore(rec)))!;
      expect(start.choice.use).toBe('stored');
      expect(Array.from(start.image!)).toEqual([7, 7]);
      expect(start.choice.why).toContain('大きすぎて');
      expect(start.choice.why).toContain('この端末に保存された中身を開きます');
    });

    it('壊れた base64 でも why に「読み取れない形」が出る', async () => {
      document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
      document.body.innerHTML =
        '<script type="application/octet-stream;base64" data-pkc-db-image>@@@</script>';
      const start = (await resolvePortableStart(document, () => fakeStore(null)))!;
      expect(start.choice.why).toContain('読み取れない形');
      expect(start.choice.use).toBe('fresh');
    });

    it('🔴 器の読みも落ちていても、両方の理由が出る', async () => {
      document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
      installUnreadable([charsFor(10)]);
      const start = (await resolvePortableStart(document, () =>
        fakeStore(null, { throwOnRead: '形が違います' }),
      ))!;
      expect(start.choice.why).toContain('大きすぎて');
      expect(start.choice.why).toContain('形が違います');
    });

    it('対照群: 正常な 1 枚では failure は null で、why に余計な文が付かない', async () => {
      document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
      document.body.innerHTML = imageTag([9, 9, 9]);
      const start = (await resolvePortableStart(document, () => fakeStore(null)))!;
      expect(start.embeddedFailure).toBeNull();
      expect(start.choice.why).toBe('保存領域がまだ空なので、配られた中身を開きます');
    });
  });
});

describe('どの中身で起動するか', () => {
  it('器が空 → 焼き込まれた画像を渡す', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    document.body.innerHTML = imageTag([9, 9, 9]);
    const start = (await resolvePortableStart(document, () => fakeStore(null)))!;
    expect(start.choice.use).toBe('embedded');
    expect(Array.from(start.image!)).toEqual([9, 9, 9]);
    expect(start.dbName).toContain(ID);
  });

  it('🔴 器のほうが新しい → 器の中身を渡す(user の編集を上書きしない)', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    document.body.innerHTML = imageTag([9, 9, 9]);
    const start = (await resolvePortableStart(document, () =>
      fakeStore({ bundleId: ID, exportedAt: 5, savedAt: 99, image: new Uint8Array([7, 7]) }),
    ))!;
    expect(start.choice.use).toBe('stored');
    expect(Array.from(start.image!)).toEqual([7, 7]);
  });

  it('🔴 器が読めなくても起動する ── 配られた中身で開き、理由を残す', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    document.body.innerHTML = imageTag([4, 4]);
    const start = (await resolvePortableStart(document, () =>
      fakeStore(null, { throwOnRead: '形が違います' }),
    ))!;
    expect(start.choice.use).toBe('embedded');
    expect(start.choice.why).toContain('形が違います');
    expect(Array.from(start.image!)).toEqual([4, 4]);
  });

  it('器も画像も無い → 空から始める(image は渡さない)', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    const start = (await resolvePortableStart(document, () => fakeStore(null)))!;
    expect(start.choice.use).toBe('fresh');
    expect(start.image).toBeNull();
  });
});
