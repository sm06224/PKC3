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
    const bytes = takeEmbeddedImage(document);
    expect(Array.from(bytes!)).toEqual([1, 2, 3, 4]);
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('壊れた base64 でも DOM から外す(読めない物を抱え続けない)', () => {
    document.body.innerHTML =
      '<script type="application/octet-stream;base64" data-pkc-db-image>@@@</script>';
    expect(takeEmbeddedImage(document)).toBeNull();
    expect(document.querySelector(IMAGE_SELECTOR)).toBeNull();
  });

  it('印だけで画像が無い形も成り立つ(空の可搬バンドル)', () => {
    expect(takeEmbeddedImage(document)).toBeNull();
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
