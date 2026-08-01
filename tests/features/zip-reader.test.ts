/**
 * P6c 段①: ZIP reader。**形式知識をゼロ持たない純機構**なので合成 fixture だけで
 * 単独に pin できる(全 8 形式の土台 ── ここが正しくないと上に何も積めない)。
 *
 * 網の重点は「読める」ことより **「読めないものを黙って通さない」** こと。
 * PKC2 の reader は CRC を検証せず、文字コードを推測し、未対応方式を skip して
 * いた ── どれも**無言の欠落**を作る形なので、そのすべてを断る側で pin する。
 */
import { describe, expect, it } from 'vitest';
import {
  readZipDirectory,
  readZipEntry,
  readZipText,
  crc32,
  ZipReadError,
} from '../../src/features/import/zip-reader';
import { buildZip, bytesOf } from './zip-fixture';

const text = async (blob: Blob): Promise<string> => blob.text();

describe('readZipDirectory', () => {
  it('目次を読む(bytes は 1 バイトも読まない)', async () => {
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf('{"format":"pkc2-package"}') },
      { name: 'assets/', bytes: bytesOf(''), isDirectory: true },
      { name: 'assets/k1.bin', bytes: bytesOf('bytes') },
    ]);
    const dir = await readZipDirectory(zip);

    expect(dir.map((e) => e.name)).toEqual(['manifest.json', 'assets/', 'assets/k1.bin']);
    expect(dir[1]!.isDirectory).toBe(true);
    expect(dir[2]!.isDirectory).toBe(false);
    expect(dir[2]!.uncompressedSize).toBe(5);
  });

  it('EOCD コメントがあっても後方走査で見つける', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }], {
      comment: 'z'.repeat(3000),
    });
    expect((await readZipDirectory(zip)).map((e) => e.name)).toEqual(['a.txt']);
  });

  it('日本語のファイル名(UTF-8 フラグあり)を読む', async () => {
    const zip = await buildZip([{ name: '添付/請求書.pdf', bytes: bytesOf('pdf') }]);
    expect((await readZipDirectory(zip))[0]!.name).toBe('添付/請求書.pdf');
  });

  it('UTF-8 の印が無い非 ASCII 名は**推測せず断る**(mojibake を作らない)', async () => {
    // PKC2 は flag を読まずに常に UTF-8 decode していた ── CP932 の ZIP が
    // 文字化けした名前で通ってしまう
    const zip = await buildZip([
      { name: '添付.pdf', bytes: bytesOf('x'), flags: 0 }, // bit 11 を落とす
    ]);
    await expect(readZipDirectory(zip)).rejects.toThrow(/文字コードを判別できません/);
  });

  it('ZIP でない / 壊れた入力は理由付きで断る', async () => {
    await expect(readZipDirectory(new Blob(['短い']))).rejects.toThrow(/小さすぎます/);
    await expect(readZipDirectory(new Blob(['x'.repeat(100)]))).rejects.toThrow(
      /EOCD|終端/,
    );
    // EOCD はあるが中央ディレクトリが範囲外を指す
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    view.setUint32(eocd + 16, 0x7fffff00, true); // cdOffset を壊す
    await expect(readZipDirectory(new Blob([buf]))).rejects.toThrow(/範囲外/);
  });

  it('ZIP64 は名指しで断る(実装しないと決めた形式を黙って誤読しない)', async () => {
    // ① EOCD 直前の ZIP64 locator
    const base = await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }]);
    const buf = new Uint8Array(await base.arrayBuffer());
    const withLocator = new Uint8Array(buf.length + 20);
    withLocator.set(buf.subarray(0, buf.length - 22));
    new DataView(withLocator.buffer).setUint32(buf.length - 22, 0x07064b50, true);
    withLocator.set(buf.subarray(buf.length - 22), buf.length - 22 + 20);
    await expect(readZipDirectory(new Blob([withLocator]))).rejects.toThrow(/ZIP64/);

    // ② 件数 0xffff(ZIP64 のプレースホルダ)
    const buf2 = new Uint8Array(await base.arrayBuffer());
    new DataView(buf2.buffer).setUint16(buf2.length - 22 + 10, 0xffff, true);
    await expect(readZipDirectory(new Blob([buf2]))).rejects.toThrow(/ZIP64/);
  });

  it('中央ディレクトリが件数ぶん無ければ断る(途中で切れた ZIP)', async () => {
    const base = await buildZip([
      { name: 'a.txt', bytes: bytesOf('x') },
      { name: 'b.txt', bytes: bytesOf('y') },
    ]);
    const buf = new Uint8Array(await base.arrayBuffer());
    const view = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    // 件数だけ 3 に増やす(CD の実体は 2 件のまま)
    view.setUint16(eocd + 8, 3, true);
    view.setUint16(eocd + 10, 3, true);
    await expect(readZipDirectory(new Blob([buf]))).rejects.toThrow(/切れて/);
  });

  it('暗号化 ZIP は名指しで断る', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('x'), flags: 0x1 }]);
    await expect(readZipDirectory(zip)).rejects.toThrow(/暗号化/);
  });

  it('中央ディレクトリの署名が壊れていたら断る', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('hello') }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(buf.buffer);
    const cdOffset = view.getUint32(buf.length - 22 + 16, true);
    view.setUint32(cdOffset, 0xdeadbeef, true);
    await expect(readZipDirectory(new Blob([buf]))).rejects.toThrow(/署名/);
  });
});

describe('readZipEntry', () => {
  it('store(method 0)を読む', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('保存された中身') }]);
    const [e] = await readZipDirectory(zip);
    expect(await text(await readZipEntry(zip, e!))).toBe('保存された中身');
  });

  it('deflate(method 8)を読む ── raw deflate であって zlib ではない', async () => {
    // 実装が 'deflate' を指定していると、ここで必ず失敗する
    const body = 'あ'.repeat(2000); // 圧縮が効く中身
    const zip = await buildZip([{ name: 'big.txt', bytes: bytesOf(body), method: 8 }]);
    const [e] = await readZipDirectory(zip);
    expect(e!.method).toBe(8);
    expect(e!.compressedSize).toBeLessThan(e!.uncompressedSize); // 実際に縮んでいる
    expect(await text(await readZipEntry(zip, e!))).toBe(body);
  });

  it('中央ディレクトリのサイズを正とする(local header が 0 でも読める)', async () => {
    // data descriptor 使用時、local header の size は 0 になる。CD を見ていないと
    // 空 Blob を返してしまう(= 無言の欠落)
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('CD が正') }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(buf.buffer);
    view.setUint32(18, 0, true); // local header の compressed size
    view.setUint32(22, 0, true); // local header の uncompressed size
    const zip2 = new Blob([buf]);
    const [e] = await readZipDirectory(zip2);
    expect(await text(await readZipEntry(zip2, e!))).toBe('CD が正');
  });

  it('CRC 不一致は断る ── **黙って壊れた bytes を返さない**', async () => {
    // PKC2 は CRC を検証しておらず、asset だけ壊れた ZIP が無言で欠けた添付になった
    const zip = await buildZip([
      { name: 'broken.bin', bytes: bytesOf('中身'), corruptCrc: true },
    ]);
    const [e] = await readZipDirectory(zip);
    await expect(readZipEntry(zip, e!)).rejects.toThrow(/壊れています|CRC/);
    // 明示的に外したときだけ通る(外すのは呼び出し側の宣言)
    expect(await text(await readZipEntry(zip, e!, { verifyCrc: false }))).toBe('中身');
  });

  it('deflate でも CRC を検証する', async () => {
    const zip = await buildZip([
      { name: 'b.txt', bytes: bytesOf('x'.repeat(500)), method: 8, corruptCrc: true },
    ]);
    const [e] = await readZipDirectory(zip);
    await expect(readZipEntry(zip, e!)).rejects.toThrow(/壊れています|CRC/);
  });

  it('未対応の圧縮方式は方式番号を出して断る(skip して欠落させない)', async () => {
    const zip = await buildZip([
      { name: 'z.bin', bytes: bytesOf('x'), method: 93 }, // zstd
    ]);
    const [e] = await readZipDirectory(zip);
    await expect(readZipEntry(zip, e!)).rejects.toThrow(/method=93/);
  });

  it('ディレクトリ entry の中身は読まない', async () => {
    const zip = await buildZip([{ name: 'd/', bytes: bytesOf(''), isDirectory: true }]);
    const [e] = await readZipDirectory(zip);
    await expect(readZipEntry(zip, e!)).rejects.toThrow(ZipReadError);
  });

  it('データが範囲外を指していたら断る', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }]);
    const [e] = await readZipDirectory(zip);
    await expect(
      readZipEntry(zip, { ...e!, compressedSize: 999_999 }),
    ).rejects.toThrow(/範囲外/);
  });

  it('0 バイトのファイルも読める(空は「無い」ではない)', async () => {
    const zip = await buildZip([{ name: 'empty.txt', bytes: bytesOf('') }]);
    const [e] = await readZipDirectory(zip);
    const blob = await readZipEntry(zip, e!);
    expect(blob.size).toBe(0);
  });

  it('readZipText: manifest / container を文字列で読む', async () => {
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf('{"format":"pkc2-package"}') },
    ]);
    const [e] = await readZipDirectory(zip);
    expect(JSON.parse(await readZipText(zip, e!))).toEqual({ format: 'pkc2-package' });
  });

  it('ZIP-in-ZIP: 内側を Blob 化して**同じ reader を再入**できる', async () => {
    // 入力が File 固定だとここが書けず、内側を全量展開する羽目になる
    const inner = await buildZip([{ name: 'body.md', bytes: bytesOf('# 内側\\n') }]);
    const outer = await buildZip([
      { name: 'manifest.json', bytes: bytesOf('{"format":"pkc2-texts-container-bundle"}') },
      { name: 'note.text.zip', bytes: new Uint8Array(await inner.arrayBuffer()) },
    ]);

    const outerDir = await readZipDirectory(outer);
    const innerBlob = await readZipEntry(outer, outerDir.find((e) => e.name.endsWith('.zip'))!);
    const innerDir = await readZipDirectory(innerBlob);
    expect(await readZipText(innerBlob, innerDir[0]!)).toBe('# 内側\\n');
  });
});

describe('crc32', () => {
  it('既知のベクタと一致する(自作 CRC が本物であることの根拠)', () => {
    expect(crc32(bytesOf(''))).toBe(0);
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926); // CRC-32/ISO-HDLC の標準値
    expect(crc32(bytesOf('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});
