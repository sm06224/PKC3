/**
 * 🔴 Office「挿入 → 画像」の**候補をノートから引く**(#146 裁定 A)。
 *
 * 守る主張:
 *  ① 引くのは **本文が `asset:` で使っている添付**のうち**画像だけ**(zip / docx は持ち主を引くことすらしない)
 *  ② 名前は**添付ノートの元の file 名**(frontmatter の `attachment.name`)
 *  ③ **引けない 1 件のために残りを止めない**(投げない)
 *  ④ 文書のノートと「いま開いているノート」の**両方**から引き、同じ key は 1 件
 */
import { describe, expect, it } from 'vitest';
import { listNoteImages, type NoteImageDeps } from '../../src/adapter/platform/office/office-note-images';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';

interface World {
  bodies: Record<string, string>;
  /** key → 添付ノートの lid */
  owners: Record<string, string>;
  /** key → Blob の大きさと種類 */
  blobs: Record<string, { size: number; type: string }>;
}

function deps(w: World, over: Partial<NoteImageDeps> = {}) {
  const calls = { owner: [] as string[], blob: [] as string[] };
  const d: NoteImageDeps = {
    getBody: async (lid) => w.bodies[lid] ?? null,
    findOwner: async (key) => {
      calls.owner.push(key);
      return w.owners[key] ?? null;
    },
    blobInfo: async (key) => {
      calls.blob.push(key);
      return w.blobs[key] ?? null;
    },
    ...over,
  };
  return { d, calls };
}

/** 添付ノート(frontmatter に名前と種類)を作る。 */
function attach(lid: string, key: string, name: string, mime: string, size = 10): Record<string, string> {
  return { [lid]: attachmentBody({ name, mime, size, assetKey: key }) };
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function world(): World {
  return {
    bodies: {
      note: '# メモ\n\n![猫](asset:ast-cat) と [報告](asset:ast-doc) と ![図](asset:ast-svg)\n',
      other: '![猫(別の参照)](asset:ast-cat) ![月](asset:ast-moon)\n',
      ...attach('a-cat', 'ast-cat', '猫.png', 'image/png'),
      ...attach('a-doc', 'ast-doc', '報告.docx', DOCX),
      ...attach('a-svg', 'ast-svg', 'logo.svg', 'image/svg+xml'),
      ...attach('a-moon', 'ast-moon', '月.jpg', 'image/jpeg'),
    },
    owners: { 'ast-cat': 'a-cat', 'ast-doc': 'a-doc', 'ast-svg': 'a-svg', 'ast-moon': 'a-moon' },
    blobs: {
      'ast-cat': { size: 100, type: 'image/png' },
      'ast-doc': { size: 5000, type: DOCX },
      'ast-svg': { size: 30, type: 'image/svg+xml' },
      'ast-moon': { size: 70, type: 'image/jpeg' },
    },
  };
}

describe('listNoteImages', () => {
  it('🔴 本文が使っている添付のうち画像だけを、元の名前つきで返す', async () => {
    const { d } = deps(world());
    const got = await listNoteImages(d, ['note']);
    expect(got.length, '空振り防止(件数 > 0)').toBeGreaterThan(0);
    expect(got).toEqual([
      { key: 'ast-cat', name: '猫.png', mime: 'image/png', size: 100 },
      { key: 'ast-svg', name: 'logo.svg', mime: 'image/svg+xml', size: 30 },
    ]);
  });

  it('🔴 画像でないと分かる添付は、持ち主を引かない(docx を何往復もさせない)', async () => {
    const { d, calls } = deps(world());
    await listNoteImages(d, ['note']);
    expect(calls.owner).not.toContain('ast-doc');
    expect(calls.owner.sort()).toEqual(['ast-cat', 'ast-svg']);
  });

  it('Blob の種類が空でも、添付ノートの種類(拡張子から引いた値)で画像と分かる', async () => {
    const w = world();
    w.blobs['ast-cat'] = { size: 100, type: '' };
    const { d } = deps(w);
    expect((await listNoteImages(d, ['note'])).map((c) => c.key)).toContain('ast-cat');
  });

  it('持ち主が見つからない(整理済み)添付は、名前が空のまま種類で決める', async () => {
    const w = world();
    delete w.owners['ast-cat'];
    const { d } = deps(w);
    const got = await listNoteImages(d, ['note']);
    expect(got.find((c) => c.key === 'ast-cat')).toEqual({
      key: 'ast-cat',
      name: '',
      mime: 'image/png',
      size: 100,
    });
  });

  it('🔴 文書のノートと「いま開いているノート」の両方から引き、同じ添付は 1 件', async () => {
    const { d } = deps(world());
    const got = await listNoteImages(d, ['note', 'other', 'other', '', null, undefined]);
    expect(got.map((c) => c.key)).toEqual(['ast-cat', 'ast-svg', 'ast-moon']);
  });

  it('本文が読めないノートは飛ばして、残りから引く', async () => {
    const { d } = deps(world());
    expect((await listNoteImages(d, ['nothing', 'other'])).map((c) => c.key)).toEqual([
      'ast-cat',
      'ast-moon',
    ]);
  });

  it('🔴 1 件の取得が投げても、残りは返る(投げない)', async () => {
    const base = world();
    const { d } = deps(base, {
      blobInfo: async (key) => {
        if (key === 'ast-cat') throw new Error('IDB が落ちた');
        return base.blobs[key] ?? null;
      },
    });
    const got = await listNoteImages(d, ['note']);
    expect(got.map((c) => c.key)).toEqual(['ast-svg']);
  });

  it('本文の取得が投げても、投げずに空を返す', async () => {
    const { d } = deps(world(), {
      getBody: async () => {
        throw new Error('worker が居ない');
      },
    });
    expect(await listNoteImages(d, ['note'])).toEqual([]);
  });

  it('添付が 0 件のノートは何も返さない(blob も引かない)', async () => {
    const w = world();
    w.bodies['empty'] = '添付なし';
    const { d, calls } = deps(w);
    expect(await listNoteImages(d, ['empty'])).toEqual([]);
    expect(calls.blob).toEqual([]);
  });
});
