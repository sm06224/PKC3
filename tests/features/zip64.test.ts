/**
 * 🔴 **4GB を超える書庫を、書き出せて取り込み直せる**(#971 段④)。
 *
 * ## 何が起きていたか
 *
 * user の保存領域が 4GB を超えたとき、**バックアップの書き出しが通らなかった**。
 * 原因は推測ではない ── `zip-writer` が自分で
 * 「ZIP 全体が 4GB を超えました(ZIP64 未対応)」と**断っていた**。
 * 読む側も `zip-reader` が「ZIP64 形式には対応していません」で断っていたので、
 * **書ける形にしても取り込み直せない**(片道になる)。だから両側を同じ日に開けた。
 *
 * ## ⚠ 4GB の書庫は作れないので、**境目を下げて同じ経路を通す**
 *
 * `Zip64Thresholds` は **test のための seam** である ── 変わるのは
 * 「いつ 8 バイトの欄へ逃がすか」だけで、**出るバイトの組み方は 1 行も変わらない**。
 * 🔑 だから「本物で通っていない」を 3 つで埋める:
 *
 * | | 何で埋めるか |
 * |---|---|
 * | ① 既定の境目が下がっていないか | 定数を**等値で pin** する |
 * | ② 出したバイトが本当に ZIP64 か | 🔴 **外の解凍ソフト**(`unzip` / python の `zipfile`)に読ませる |
 * | ③ 8 バイトの数が 4GB 超で化けないか | `zip-int.ts` を**直に**当てる(下の describe) |
 *
 * ⚠ ②がいちばん効く ── 自作の reader だけで往復させると、
 * **writer と reader が同じ間違いをしていても緑**になる(CLAUDE.md §7)。
 */
/** @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ZipWriter } from '../../src/features/export/zip-writer';
import { readU64, u64bytes } from '../../src/features/export/zip-int';
import { readZipDirectory, readZipEntry } from '../../src/features/import/zip-reader';

/** 🔑 境目をうんと下げる ── これで小さい file でも 8 バイトの欄を通る。 */
const FORCE = { size: 8, count: 1 } as const;

const FILES: readonly { name: string; body: string }[] = [
  { name: 'a.txt', body: 'これは 8 バイトより長い日本語の本文です' },
  { name: 'ノート/深い/名前.md', body: '# 見出し\n\n本文' },
  { name: 'c.bin', body: 'x'.repeat(500) },
];

async function build(thresholds?: { size?: number; count?: number }): Promise<{
  blob: Blob;
  used: boolean;
}> {
  const w = new ZipWriter(thresholds);
  for (const f of FILES) await w.add(f.name, [f.body]);
  const blob = w.finish();
  return { blob, used: w.usedZip64 };
}

const tmp = mkdtempSync(join(tmpdir(), 'pkc3-zip64-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ZIP64 で書いて、読み直す(#971 段④)', () => {
  it('🔴 4GB を超える形でも、自前の読み手が 1 件も欠けずに読める', async () => {
    const { blob, used } = await build(FORCE);
    // ⚠ 前提の assert ── 逃がしていなければ、下は ZIP32 を見ているだけである
    expect(used, '8 バイトの欄へ 1 つも逃がしていない(この test は何も見ていない)').toBe(true);

    const dir = await readZipDirectory(blob);
    expect(dir.map((e) => e.name)).toEqual(FILES.map((f) => f.name));
    for (const f of FILES) {
      const entry = dir.find((e) => e.name === f.name)!;
      const got = await readZipEntry(blob, entry);
      expect(await got.text(), `中身が違う: ${f.name}`).toBe(f.body);
    }
  });

  /**
   * 🔴 **対照群** ── 境目が既定なら、**1 バイトも形が変わらない**。
   * ⚠ ここが崩れると、小さい書庫まで ZIP64 になって**古い解凍ソフトで開けなくなる**。
   */
  it('🔴 普通の大きさでは ZIP64 の欄を 1 つも使わない(古い読み手が読めるまま)', async () => {
    const plain = await build();
    expect(plain.used, '要らないのに ZIP64 にした').toBe(false);
    const bytes = new Uint8Array(await plain.blob.arrayBuffer());
    expect(findSig(bytes, 0x06064b50), 'ZIP64 の終端が入っている').toBe(-1);
    expect(findSig(bytes, 0x07064b50), 'ZIP64 の位置札が入っている').toBe(-1);

    // ⚠ 逃がした側には**在る**こと(上の -1 が「そもそも探せていない」ではない)
    const forced = await build(FORCE);
    const fb = new Uint8Array(await forced.blob.arrayBuffer());
    expect(findSig(fb, 0x06064b50), '逃がしたのに終端が無い').toBeGreaterThan(-1);
    expect(findSig(fb, 0x07064b50), '逃がしたのに位置札が無い').toBeGreaterThan(-1);
  });

  /**
   * 🔴 **`0xffffffff` の印が、本当に立っているか**。
   *
   * ⚠ ここを別に見るのは、**境目を下げた test では見分けが付かない**からである ──
   *   逃がした値そのものは小さいので、印を書かずに**本当の大きさ**を 4 バイト欄へ
   *   書いても、この test の範囲では往復してしまう。
   * 🔴 ところが本物の 4GB では、4 バイト欄に入り切らず**下 32bit だけが残る** ──
   *   読み手は「小さいファイル」と思って**途中で切って返す**(黙って欠ける)。
   * 🔑 だから**印そのものを構造で見る**(大きさに依らない観測点)。
   */
  it('🔴 逃がした欄には 0xffffffff の印が立っている(本当の値を書き残さない)', async () => {
    const { blob, used } = await build(FORCE);
    expect(used).toBe(true);
    const b = new Uint8Array(await blob.arrayBuffer());

    // 先頭の local header(署名 4 + 版 2 + 旗 2 + 方式 2 + 時 2 + 日 2 + CRC 4 = 18)
    const lh = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(lh.getUint32(0, true), '先頭が local header でない').toBe(0x04034b50);
    expect(lh.getUint32(18, true), '圧縮後の大きさに印が立っていない').toBe(0xffffffff);
    expect(lh.getUint32(22, true), '元の大きさに印が立っていない').toBe(0xffffffff);

    // 中央ディレクトリの 1 件目 ── 位置の欄(+42)にも印が立つ(2 件目以降)
    const cd = findSig(b, 0x02014b50);
    expect(cd, '中央ディレクトリが無い').toBeGreaterThan(-1);
    expect(lh.getUint32(cd + 20, true), 'CD の圧縮後に印が立っていない').toBe(0xffffffff);
    expect(lh.getUint32(cd + 24, true), 'CD の元の大きさに印が立っていない').toBe(0xffffffff);

    // ⚠ 終端の欄も印(件数 1 を超えて逃がしているので)
    const eocd = b.length - 22;
    expect(lh.getUint32(eocd, true), '終端が見つからない').toBe(0x06054b50);
    expect(lh.getUint16(eocd + 10, true), '件数に印が立っていない').toBe(0xffff);
  });

  /**
   * 🔴 **外の解凍ソフトに読ませる**(いちばん効く検算)。
   *
   * ⚠ 自作の writer と reader だけで往復させると、**両方が同じ間違いをしていても緑**
   *   になる(CLAUDE.md §7「両端が相手を模した stub と話している」)。
   */
  it('🔴 外の解凍ソフト(unzip / python)が、同じ中身を読み出せる', async () => {
    const { blob } = await build(FORCE);
    const path = join(tmp, 'forced-zip64.zip');
    writeFileSync(path, Buffer.from(await blob.arrayBuffer()));

    // ① unzip -t(CRC と構造の検査)
    const t = execFileSync('unzip', ['-t', path], { encoding: 'utf-8' });
    expect(t, 'unzip が異常を出した').toMatch(/No errors detected/);

    // ② python の zipfile ── **中身の字まで**突き合わせる
    const script = [
      'import json,sys,zipfile',
      'z=zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', script, path], { encoding: 'utf-8' });
    const got = JSON.parse(out) as Record<string, string>;
    for (const f of FILES) {
      expect(got[f.name], `外の読み手が違う中身を返した: ${f.name}`).toBe(f.body);
    }
  });
});

describe('8 バイトの数(#971 段④)', () => {
  /**
   * 🔴 **ここがいちばん静かに壊れる** ── ビット演算で書くと 32bit へ丸められ、
   *   4GB を超えた値が **0 付近へ化ける**(型は `number` のままなので tsc は黙る)。
   */
  it('🔴 4GB を超える値が往復する', () => {
    for (const v of [0, 1, 0xffffffff, 0x100000000, 5_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const b = u64bytes(v);
      expect(b).toHaveLength(8);
      const view = new DataView(new Uint8Array(b).buffer);
      expect(readU64(view, 0), `往復しない: ${v}`).toBe(v);
    }
  });

  it('⚠ 正確に表せない値は断る(黙ってずれた数を書かない)', () => {
    expect(() => u64bytes(-1)).toThrow();
    expect(() => u64bytes(1.5)).toThrow();
    expect(() => u64bytes(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    // 読む側も同じ ── 上位が埋まっていたら断る
    const big = new DataView(new Uint8Array([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]).buffer);
    expect(() => readU64(big, 0)).toThrow();
  });
});

describe('既定の境目(#971 段④)', () => {
  /**
   * ⚠ seam を足した日に既定が下がっていたら**事故**である ── 小さい書庫まで
   *   ZIP64 になって、古い解凍ソフトで開けなくなる。
   */
  it('🔴 既定は本物の上限のまま(seam で下がっていない)', async () => {
    const w = new ZipWriter();
    await w.add('a.txt', ['x'.repeat(100)]);
    expect(w.usedZip64, '100 バイトで ZIP64 になった(既定が下がっている)').toBe(false);
    const bytes = new Uint8Array(await w.finish().arrayBuffer());
    expect(findSig(bytes, 0x06064b50)).toBe(-1);
  });
});

/** 4 バイトの署名を探す(⚠ 見つからなければ -1)。 */
function findSig(bytes: Uint8Array, sig: number): number {
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = (sig >>> 24) & 0xff;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === b0 && bytes[i + 1] === b1 && bytes[i + 2] === b2 && bytes[i + 3] === b3) {
      return i;
    }
  }
  return -1;
}
