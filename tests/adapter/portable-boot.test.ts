/** @vitest-environment happy-dom */
/**
 * 🔴 **可搬単一 HTML の起動**(#400 段③)。
 *
 * ⚠ いちばん守るのは「**素の PKC3 では何も起きない**」である ── 印が無い限り
 * `null` を返す。ここが崩れると、可搬のために足した経路が**全 user の起動**へ漏れる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  latestPortableImage,
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

  it('🔴 割って焼いた画像(#1416 §7-4)は繋がって 1 バイトも違わず戻り、全部 DOM から外れる', () => {
    const P = 3 * 1024 * 1024; // 途中の要素は IMAGE_PART_BYTES ちょうど
    const bytes = (n: number, seed: number): Uint8Array => {
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = (i * 37 + seed) & 255;
      return a;
    };
    const b64 = (a: Uint8Array): string => {
      let bin = '';
      for (let i = 0; i < a.length; i += 8192) bin += String.fromCharCode(...a.subarray(i, i + 8192));
      return btoa(bin);
    };
    const p0 = bytes(P, 5);
    const p1 = bytes(P, 9);
    const p2 = bytes(10, 1);
    const part = (i: number, a: Uint8Array) =>
      `<script type="application/octet-stream;base64" data-pkc-db-image="${i}/3">${b64(a)}</script>`;
    document.body.innerHTML = part(0, p0) + part(1, p1) + part(2, p2);
    expect(document.querySelectorAll(IMAGE_SELECTOR).length).toBe(3); // 空振り防止
    const held = Array.from(document.querySelectorAll(IMAGE_SELECTOR));
    expect(held.every((e) => (e.textContent ?? '').length > 0)).toBe(true); // 空振り防止
    const r = takeEmbeddedImage(document);
    expect(r.failure).toBeNull();
    const img = r.image!;
    expect(img.byteLength).toBe(2 * P + 10);
    expect(img.subarray(0, P).every((v, i) => v === p0[i])).toBe(true);
    expect(img.subarray(P, 2 * P).every((v, i) => v === p1[i])).toBe(true);
    expect(Array.from(img.subarray(2 * P))).toEqual(Array.from(p2));
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
    // 🔴 外した要素が base64 の Text node を握り続けない(外しただけでは文字列が手放されない)
    for (const el of held) expect(el.textContent, '外した要素が base64 を握っている').toBe('');
  });

  it('🔴 割った要素が欠けていたら、黙って繋がず理由を返す(image は null、残りも外す)', () => {
    const part = (i: number, n: number, b: number[]) =>
      `<script type="application/octet-stream;base64" data-pkc-db-image="${i}/${n}">${btoa(
        String.fromCharCode(...b),
      )}</script>`;
    // 3 つに割ったはずが、真ん中が無い
    document.body.innerHTML = part(0, 3, [1, 2, 3]) + part(2, 3, [7, 8, 9]);
    expect(document.querySelectorAll(IMAGE_SELECTOR).length).toBe(2); // 空振り防止
    const r = takeEmbeddedImage(document);
    expect(r.image).toBeNull();
    expect(r.failure).toContain('読み取れない形');
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('🔴 割った要素の途中が短く切れていたら、後ろをずらして繋がず「何個目が欠けている」と言う', () => {
    const b64 = (n: number, seed: number): string => {
      let bin = '';
      for (let i = 0; i < n; i++) bin += String.fromCharCode((i * 7 + seed) & 255);
      return btoa(bin);
    };
    const part = (i: number, text: string) =>
      `<script type="application/octet-stream;base64" data-pkc-db-image="${i}/3">${text}</script>`;
    const P = 3 * 1024 * 1024;
    document.body.innerHTML = part(0, b64(P, 1)) + part(1, b64(P - 3, 2)) + part(2, b64(9, 3));
    const r = takeEmbeddedImage(document);
    expect(r.image).toBeNull();
    expect(r.failure).toContain('2 個目が途中で欠けています');
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('割った要素の一部が空なら失敗(空の部分を飛ばして短い画像を作らない)', () => {
    document.body.innerHTML =
      `<script type="application/octet-stream;base64" data-pkc-db-image="0/2">${btoa('abc')}</script>` +
      '<script type="application/octet-stream;base64" data-pkc-db-image="1/2"> </script>';
    const r = takeEmbeddedImage(document);
    expect(r.image).toBeNull();
    expect(r.failure).not.toBeNull();
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
      expect(start.choice.why).toBe('このブラウザにはまだ保存されたノートが無いので、この HTML ファイルに埋め込まれた中身を開きます');
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

describe('🔴 昇格・待ち明けは器の最新から開く(多重タブ T1)', () => {
  const rec = (savedAt: number, bytes: number[], bundleId = ID) => ({
    bundleId,
    exportedAt: 5,
    savedAt,
    image: new Uint8Array(bytes),
  });
  /** 起動したあとで器の中身を差し替えられる代役。 */
  function swappable(first: ReturnType<typeof rec> | null) {
    let cur: ReturnType<typeof rec> | null | 'throw' = first;
    const store = {
      read: async () => {
        if (cur === 'throw') throw new Error('読めない');
        return cur === null ? null : { ...cur, bytes: cur.image.byteLength };
      },
    } as unknown as DbImageStore;
    return { store, set: (v: typeof cur) => (cur = v) };
  }

  it('起動のあとに先のタブが器へ新しい画像を書いた → 昇格はそちらを開く(起動の画像ではない)', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    const sw = swappable(rec(10, [1, 1]));
    const start = (await resolvePortableStart(document, () => sw.store))!;
    expect(Array.from(start.image!)).toEqual([1, 1]);
    sw.set(rec(50, [2, 2, 2]));
    expect(Array.from((await latestPortableImage(start))!)).toEqual([2, 2, 2]);
  });

  it('器が読めない → 起動の画像へ戻る(投げない)', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    const sw = swappable(rec(10, [1, 1]));
    const start = (await resolvePortableStart(document, () => sw.store))!;
    sw.set('throw');
    expect(Array.from((await latestPortableImage(start))!)).toEqual([1, 1]);
  });

  it('別の PKC3 の記録・空の記録は採らない', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    const sw = swappable(rec(10, [1, 1]));
    const start = (await resolvePortableStart(document, () => sw.store))!;
    sw.set(rec(50, [9, 9], 'pkcb-other'));
    expect(Array.from((await latestPortableImage(start))!)).toEqual([1, 1]);
    sw.set(rec(50, []));
    expect(Array.from((await latestPortableImage(start))!)).toEqual([1, 1]);
  });

  it('起動で埋め込みを選んだ回: 器が埋め込みより古いままなら埋め込みのまま / 新しく書かれたら器', async () => {
    document.head.innerHTML = tag({ id: ID, exportedAt: 5 });
    document.body.innerHTML = imageTag([4, 4]);
    const sw = swappable(null);
    const start = (await resolvePortableStart(document, () => sw.store))!;
    expect(start.choice.use).toBe('embedded');
    sw.set(rec(1, [8, 8]));
    expect(Array.from((await latestPortableImage(start))!)).toEqual([4, 4]);
    sw.set(rec(99, [7, 7, 7]));
    expect(Array.from((await latestPortableImage(start))!)).toEqual([7, 7, 7]);
  });
});
