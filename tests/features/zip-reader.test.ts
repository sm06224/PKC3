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

  it('bit 11 が無くても **妥当な UTF-8 なら読む**(Info-ZIP が作る形)', async () => {
    // 🔑 Linux / macOS の `zip` は UTF-8 の名前を bit 11 を立てずに書く。
    // 「bit 11 が無い かつ 非 ASCII なら拒否」は**正しい ZIP を丸ごと拒否**する
    // ── しかも deflate 対応の動機だった「ZIP ツールで再梱包したファイル」がそれ
    const zip = await buildZip([
      { name: '添付/請求書.pdf', bytes: bytesOf('x'), flags: 0 },
      { name: 'manifest.json', bytes: bytesOf('{}'), flags: 0 },
    ]);
    const dir = await readZipDirectory(zip);
    expect(dir.map((e) => e.name)).toEqual(['添付/請求書.pdf', 'manifest.json']);
  });

  it('妥当な UTF-8 でない名前は**推測せず断る**(bit 11 の有無に関わらず)', async () => {
    // CP932 の「添付」= 0x93 0x59 0x95 0x74。UTF-8 として不正
    const cp932 = new Uint8Array([0x93, 0x59, 0x95, 0x74, 0x2e, 0x70, 0x64, 0x66]);
    for (const flags of [0, 0x800]) {
      // bit 11 が立っていても信じない ── 立っていれば通していた頃は
      // 名前が U+FFFD に化け、`assets/<key>.bin` の照合が外れて添付が黙って欠けた
      const zip = await buildZip([{ name: 'x', rawName: cp932, bytes: bytesOf('x'), flags }]);
      await expect(readZipDirectory(zip)).rejects.toThrow(/文字コードを判別できません/);
    }
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
    // ⚠ 検証を外す逃げ道は**持たない**。逃げ道はサイズ照合まで一緒に落として
    // 「他人の entry の中身が返る」経路を開けていた(review M-5)
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
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('x'.repeat(50)), method: 8 }]);
    const [e] = await readZipDirectory(zip);
    // deflate なら「store のサイズ不整合」検査に掛からず、範囲検査まで到達する
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

describe('実物の ZIP が持つ形(合成 fixture では見落とす縁)', () => {
  it('local header と中央ディレクトリで extra 長が違っても読める', async () => {
    // Info-ZIP は LH extra 28 / CD extra 24 と**食い違う**値を書く。
    // データ開始位置を CD の extra 長で計算する実装はここで CRC 不一致になり、
    // user に「あなたの ZIP は壊れています」という嘘の診断を出す
    const zip = await buildZip([
      {
        name: 'a.txt',
        bytes: bytesOf('extra があっても読める'),
        localExtra: new Uint8Array(28).fill(7),
        centralExtra: new Uint8Array(24).fill(9),
      },
    ]);
    const [e] = await readZipDirectory(zip);
    expect(await (await readZipEntry(zip, e!)).text()).toBe('extra があっても読める');
  });

  it('中央ディレクトリの extra / comment を跨いで次の entry へ進む', async () => {
    const zip = await buildZip([
      { name: 'a.txt', bytes: bytesOf('A'), centralExtra: new Uint8Array(13).fill(1) },
      { name: 'b.txt', bytes: bytesOf('B'), centralExtra: new Uint8Array(5).fill(2) },
    ]);
    const dir = await readZipDirectory(zip);
    expect(dir.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
    expect(await (await readZipEntry(zip, dir[1]!)).text()).toBe('B');
  });

  it('ディレクトリ判定は名前・外部属性の**どちらか片方**でも効く', async () => {
    // python は名前だけ(末尾 /)、Info-ZIP は両方立てる ── 片方しか見ない実装は
    // 実物のどちらかで必ず取りこぼす
    const zip = await buildZip([
      { name: 'byname/', bytes: bytesOf(''), isDirectory: false }, // 名前だけ
      { name: 'byattr', bytes: bytesOf(''), isDirectory: true }, // 属性だけ
    ]);
    const dir = await readZipDirectory(zip);
    expect(dir.map((e) => e.isDirectory)).toEqual([true, true]);
  });

  it('前置バイトのある ZIP(自己解凍書庫の形)を読む ── 嘘の「壊れています」を出さない', async () => {
    const base = await buildZip([
      { name: 'manifest.json', bytes: bytesOf('{"format":"pkc2-package"}') },
      { name: 'assets/k.bin', bytes: bytesOf('前置があっても読める') },
    ]);
    const prefixed = new Blob([new Uint8Array(1000).fill(0x5a), base]);
    const dir = await readZipDirectory(prefixed);
    expect(dir.map((e) => e.name)).toEqual(['manifest.json', 'assets/k.bin']);
    expect(await (await readZipEntry(prefixed, dir[1]!)).text()).toBe('前置があっても読める');
  });

  it('分割書庫(マルチディスク)は名指しで断る', async () => {
    const base = await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }]);
    const buf = new Uint8Array(await base.arrayBuffer());
    new DataView(buf.buffer).setUint16(buf.length - 22 + 4, 3, true);
    await expect(readZipDirectory(new Blob([buf]))).rejects.toThrow(/分割された ZIP/);
  });

  it('EOCD 署名が偶然含まれていても本物を選ぶ(comment 長で検証する)', async () => {
    // 本体に EOCD signature と同じ 4 バイトが並ぶだけで「空 ZIP」と誤読していた
    const fake = new Uint8Array(64);
    new DataView(fake.buffer).setUint32(10, 0x06054b50, true);
    const zip = await buildZip([{ name: 'a.txt', bytes: fake }]);
    expect((await readZipDirectory(zip)).map((e) => e.name)).toEqual(['a.txt']);
  });

  it('ZIP でないバイナリを「空 ZIP」として受理しない', async () => {
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 0xff;
    // 途中に EOCD 署名 + 18 バイトのゼロ(= 件数 0 の EOCD に見える形)を置く
    junk.set([0x50, 0x4b, 0x05, 0x06], 2000);
    junk.fill(0, 2004, 2022);
    await expect(readZipDirectory(new Blob([junk]))).rejects.toThrow(/EOCD|終端/);
  });

  it('EOCD の件数が中身と合わなければ断る(entry を黙って消さない)', async () => {
    const base = await buildZip([
      { name: 'a.txt', bytes: bytesOf('A') },
      { name: 'b.txt', bytes: bytesOf('B') },
    ]);
    const buf = new Uint8Array(await base.arrayBuffer());
    const view = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    view.setUint16(eocd + 8, 1, true); // 件数だけ 1 に減らす
    view.setUint16(eocd + 10, 1, true);
    // 旧実装は b.txt をエラー無しで落としていた
    await expect(readZipDirectory(new Blob([buf]))).rejects.toThrow(/件数が合いません/);
  });

  it('中央ディレクトリが名前の途中で切れていたら断る(名前を黙って縮めない)', async () => {
    // `subarray` は範囲外を**黙って clamp** するので、境界を見ていないと
    // 名前が静かに縮む(最後の 1 件は次の CD 署名検査にも掛からず素通りする)
    const base = await buildZip([{ name: 'assets/very-long-key-name.bin', bytes: bytesOf('x') }]);
    const buf = new Uint8Array(await base.arrayBuffer());
    const view = new DataView(buf.buffer);
    const cdOffset = view.getUint32(buf.length - 22 + 16, true);
    // CD の nameLen だけを実体より大きく偽装する
    view.setUint16(cdOffset + 28, 200, true);
    await expect(readZipDirectory(new Blob([buf]))).rejects.toThrow(/切れて/);
  });

  it('local header の署名が壊れていたら断る(entry と ZIP を結ぶ唯一の検査)', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    new DataView(buf.buffer).setUint32(0, 0xdeadbeef, true);
    const zip2 = new Blob([buf]);
    const [e] = await readZipDirectory(zip2);
    await expect(readZipEntry(zip2, e!)).rejects.toThrow(/ヘッダ署名/);
  });

  it('store なのに圧縮前後のサイズが違う目次は断る', async () => {
    const zip = await buildZip([{ name: 'a.txt', bytes: bytesOf('0123456789') }]);
    const [e] = await readZipDirectory(zip);
    await expect(readZipEntry(zip, { ...e!, compressedSize: 4 })).rejects.toThrow(
      /store なのにサイズ/,
    );
  });

  it('別 ZIP の entry を渡したら断る + 文面が user のデータを一方的に疑わない', async () => {
    const a = await buildZip([{ name: 'a.txt', bytes: bytesOf('AAAAAAAAAA') }]);
    const b = await buildZip([{ name: 'a.txt', bytes: bytesOf('BBBBBBBBBB') }]);
    const [ea] = await readZipDirectory(a);
    await expect(readZipEntry(b, ea!)).rejects.toThrow(/出所が違います/);
  });

  it('サイズだけが目次と違う壊れ方も断る(CRC が偶然一致する形)', async () => {
    // 空の entry は CRC が 0。目次のサイズだけを 10 に偽装すると **CRC 検査は
    // 通ってしまう** ── サイズ照合を持たないと「10 バイトのはずが 0 バイト」が
    // 黙って通る(review M4: 照合を外しても誰も気づかなかった箇所)
    const zip = await buildZip([{ name: 'empty.bin', bytes: bytesOf(''), method: 8 }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(buf.buffer);
    const cdOffset = view.getUint32(buf.length - 22 + 16, true);
    view.setUint32(cdOffset + 24, 10, true); // CD の uncompressedSize
    const zip2 = new Blob([buf]);
    const [e] = await readZipDirectory(zip2);
    expect(e!.crc32).toBe(0); // CRC は一致する
    await expect(readZipEntry(zip2, e!)).rejects.toThrow(/サイズが目次と違います/);
  });

  it('圧縮データが壊れていたら理由の分かる文面で断る', async () => {
    const zip = await buildZip([
      { name: 'b.txt', bytes: bytesOf('x'.repeat(500)), method: 8 },
    ]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    buf[40] = buf[40]! ^ 0xff; // 圧縮データを壊す
    buf[41] = buf[41]! ^ 0xff;
    const zip2 = new Blob([buf]);
    const [e] = await readZipDirectory(zip2);
    await expect(readZipEntry(zip2, e!)).rejects.toThrow(/圧縮データが壊れています|CRC/);
  });
});
