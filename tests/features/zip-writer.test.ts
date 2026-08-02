/**
 * P6d 段①: ZIP writer。
 *
 * 🔑 **すべて round-trip で見る**(書いて → 自分の reader で読んで → 中身が一致)。
 * PKC2 は writer と reader を別々に書いて食い違わせていた(拡張子ストリップの
 * 正規表現 / `compact` と `compacted` の綴り / bit 11 を書くが読まない)──
 * 対で test すれば構造的に起きない。
 *
 * ⚠ round-trip だけでは**両方が同じように間違っている**場合を捕まえられないので、
 * 「reader を通さず生バイトを見る」assert も混ぜる(署名 / 常駐しない形)。
 */
import { describe, expect, it } from 'vitest';
import { ZipWriter, ZipWriteError } from '../../src/features/export/zip-writer';
import {
  readZipDirectory,
  readZipEntry,
  readZipText,
  crc32,
} from '../../src/features/import/zip-reader';

const enc = new TextEncoder();
const bytesOf = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s);

/** 書いて読む(この 2 つが対であることがこの module の存在意義)。 */
async function roundTrip(
  files: ReadonlyArray<{ name: string; parts: Array<string | Blob> }>,
): Promise<Map<string, string>> {
  const w = new ZipWriter();
  for (const f of files) await w.add(f.name, f.parts);
  const zip = w.finish();
  const dir = await readZipDirectory(zip);
  const out = new Map<string, string>();
  for (const e of dir) out.set(e.name, await readZipText(zip, e));
  return out;
}

describe('ZipWriter — round-trip', () => {
  it('書いたものを自分の reader が読める', async () => {
    const got = await roundTrip([
      { name: 'manifest.json', parts: ['{"format":"pkc3-archive"}'] },
      { name: 'body.md', parts: ['# 見出し\n本文\n'] },
    ]);
    expect(got.get('manifest.json')).toBe('{"format":"pkc3-archive"}');
    expect(got.get('body.md')).toBe('# 見出し\n本文\n');
  });

  it('🔑 部品を分けて渡しても連結した中身になる(巨大文字列を作らないための性質)', async () => {
    // JSON を丸ごと 1 本の文字列にしないための土台 ── ここが崩れると
    // 「entries を 1 件ずつ積む」書き方ができない
    const got = await roundTrip([
      {
        name: 'container.json',
        parts: ['{"entries":[', '{"lid":"a"}', ',', '{"lid":"b"}', ']}'],
      },
    ]);
    expect(JSON.parse(got.get('container.json')!)).toEqual({
      entries: [{ lid: 'a' }, { lid: 'b' }],
    });
  });

  it('Blob の部品(= IDB の asset)をそのまま入れられる', async () => {
    const asset = new Blob([bytesOf('PNG のバイト列')]);
    const got = await roundTrip([{ name: 'assets/k1', parts: [asset] }]);
    expect(got.get('assets/k1')).toBe('PNG のバイト列');
  });

  it('文字列と Blob を混ぜても正しい', async () => {
    const got = await roundTrip([
      { name: 'mixed', parts: ['あたま', new Blob([bytesOf('なか')]), 'しっぽ'] },
    ]);
    expect(got.get('mixed')).toBe('あたまなかしっぽ');
  });

  it('🔑 日本語のファイル名が往復する(実運用の名前はほぼ日本語)', async () => {
    // PKC2 の slugify は CJK を残すので、実データのファイル名は日本語になる
    const got = await roundTrip([{ name: '議事録-20260731.md', parts: ['# 議事録\n'] }]);
    expect([...got.keys()]).toEqual(['議事録-20260731.md']);
  });

  it('空ファイルも書ける(0 バイトの添付は実在する)', async () => {
    const got = await roundTrip([{ name: 'empty.bin', parts: [] }]);
    expect(got.get('empty.bin')).toBe('');
  });

  it('多数のファイルでも目次が壊れない(offset の積み上げ)', async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      name: `e/${i}.md`,
      parts: [`# ${i}\n${'x'.repeat(i)}\n`],
    }));
    const got = await roundTrip(files);
    expect(got.size).toBe(200);
    expect(got.get('e/199.md')).toBe(`# 199\n${'x'.repeat(199)}\n`);
  });
});

describe('ZipWriter — 生バイトの検査(reader を通さない)', () => {
  it('CRC-32 が**実際の中身**と一致する(reader と同じ誤りをしていないこと)', async () => {
    const body = '# 見出し\n本文\n';
    const w = new ZipWriter();
    await w.add('body.md', [body]);
    const buf = new Uint8Array(await w.finish().arrayBuffer());
    // local header の CRC 位置は 14
    const view = new DataView(buf.buffer);
    expect(view.getUint32(14, true)).toBe(crc32(enc.encode(body)));
  });

  it('store 固定 + UTF-8 flag(reader が bit 11 を見ないことに依存しない)', async () => {
    const w = new ZipWriter();
    await w.add('あ.md', ['x']);
    const view = new DataView(await w.finish().arrayBuffer());
    expect(view.getUint16(6, true)).toBe(0x0800); // flags
    expect(view.getUint16(8, true)).toBe(0); // method = store
  });

  it('🔑 部品の Blob をコピーしない(finish は参照を並べるだけ)', async () => {
    // 「同じ Blob を 2 回書いても入力の Blob が消費されない」= stream で舐めた後も
    // 元の Blob が生きている(消費してしまう実装だと 2 回目が空になる)
    const asset = new Blob([bytesOf('AAAA')]);
    const got = await roundTrip([
      { name: 'a', parts: [asset] },
      { name: 'b', parts: [asset] },
    ]);
    expect(got.get('a')).toBe('AAAA');
    expect(got.get('b')).toBe('AAAA');
  });
});

describe('ZipWriter — 読めないものを出さない', () => {
  it('同名を 2 回書こうとしたら断る(reader が後勝ちで捨てる形を作らない)', async () => {
    const w = new ZipWriter();
    await w.add('a.md', ['1']);
    await expect(w.add('a.md', ['2'])).rejects.toThrow(ZipWriteError);
  });

  it('名前が空なら断る', async () => {
    const w = new ZipWriter();
    await expect(w.add('', ['x'])).rejects.toThrow(/名前が空/);
  });

  it('measure が投げても名前を確保しない(同名で再試行できる)', async () => {
    const w = new ZipWriter();
    const broken = { stream: () => { throw new Error('読めない'); } } as unknown as Blob;
    await expect(w.add('a.md', [broken])).rejects.toThrow();
    // 名前だけ残っていると、正しい中身での再試行が「重複」で断られる
    await w.add('a.md', ['ちゃんとした中身']);
    expect(w.count).toBe(1);
  });

  it('finish 後の add は断る(壊れた ZIP を作らない)', async () => {
    const w = new ZipWriter();
    await w.add('a.md', ['x']);
    w.finish();
    await expect(w.add('b.md', ['y'])).rejects.toThrow(/閉じた/);
  });

  it('件数を数えられる(0 件の ZIP を黙って出さないため)', async () => {
    const w = new ZipWriter();
    expect(w.count).toBe(0);
    await w.add('a', ['x']);
    expect(w.count).toBe(1);
  });

  it('0 件でも壊れた ZIP にはならない(呼び出し側が断れるように)', async () => {
    const zip = new ZipWriter().finish();
    expect(await readZipDirectory(zip)).toEqual([]);
  });
});

describe('ZipWriter — reader の検査に本当に噛み合うか', () => {
  it('中身を 1 バイト壊すと reader が断る(CRC 検査が噛み合っていることの確認)', async () => {
    // ⚠ **local header の CRC を壊しても検知されない**のが正しい挙動 ──
    // reader は中央ディレクトリを正とするから(段① の設計)。壊すのは中身の側
    const w = new ZipWriter();
    await w.add('a.bin', ['0123456789']);
    const buf = new Uint8Array(await w.finish().arrayBuffer());
    // local header は 30 + 名前 5 バイト = 35 から中身
    buf[35] = buf[35]! ^ 0xff;
    const broken = new Blob([buf]);
    const [e] = await readZipDirectory(broken);
    await expect(readZipEntry(broken, e!)).rejects.toThrow(/CRC|壊れています/);
  });
});
