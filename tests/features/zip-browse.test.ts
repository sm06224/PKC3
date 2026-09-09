/**
 * 🔴 **書庫の中を見て、選んだ物だけ取り出す**(#818)の純粋な層。
 *
 * ⚠ ここが守るのは 4 つ:①**階層を起こす**(zip がフォルダの行を持たなくても)
 * ②**フォルダの印は、その下の file 全部** ③**重複は 1 件**
 * ④**名前はぶつかったときだけ長くする**。
 */
import { describe, expect, it } from 'vitest';
import type { ZipEntry } from '../../src/features/import/zip-reader';
import {
  archiveRows,
  extractNames,
  markedFiles,
  toggleArchiveMark,
} from '../../src/features/archive/zip-browse';

const file = (name: string, size = 10): ZipEntry => ({
  name,
  method: 8,
  compressedSize: size,
  uncompressedSize: size,
  crc32: 0,
  localHeaderOffset: 0,
  isDirectory: false,
});
const dir = (name: string): ZipEntry => ({ ...file(name, 0), isDirectory: true });

describe('一覧の行を組む', () => {
  /**
   * 🔴 **フォルダの行を持たない zip でも階層が出る** ── 起こさないと
   * `写真/2026/海.jpg` が根に 1 件として並び、user の言う「階層」が消える。
   */
  it('file の path から親を起こす', () => {
    const rows = archiveRows([file('写真/2026/海.jpg')]);
    expect(rows.map((r) => [r.path, r.depth, r.isDirectory])).toEqual([
      ['写真', 0, true],
      ['写真/2026', 1, true],
      ['写真/2026/海.jpg', 2, false],
    ]);
  });

  it('フォルダが先、その中は名前順', () => {
    const rows = archiveRows([file('b.txt'), file('a.txt'), dir('z')]);
    expect(rows.map((r) => r.name)).toEqual(['z', 'a.txt', 'b.txt']);
  });

  it('大きさを持つ(フォルダは 0)', () => {
    const rows = archiveRows([file('a.txt', 2048)]);
    expect(rows.map((r) => [r.name, r.size])).toEqual([['a.txt', 2048]]);
  });

  /** ⚠ 押せない行を並べない。 */
  it('壊れた path は捨てる', () => {
    expect(archiveRows([file('a//b.txt'), file(''), file('/')])).toEqual([]);
  });

  /**
   * 🔴 **同じ名前の file とフォルダが両方在っても、行は 1 つ**(変異試験 A7)。
   *
   * ⚠ zip は `写真`(file)と `写真/海.jpg` を同時に持てる。放っておくと
   *   **同じ path の行が 2 つ**並び、印は path で名指すので**片方を選ぶと
   *   両方が選ばれる**(押した物と違う物が取り出される)。
   * 🔑 下に物が在るほうを残す ── フォルダを優先する。
   */
  it('🔴 同じ名前の file とフォルダが在ったら、フォルダを残す', () => {
    const rows = archiveRows([file('写真'), file('写真/海.jpg')]);
    expect(rows.filter((r) => r.path === '写真')).toHaveLength(1);
    expect(rows.find((r) => r.path === '写真')?.isDirectory).toBe(true);
  });

  /** ⚠ 末尾の `/` はフォルダの印なので、名前からは落とす。 */
  it('フォルダの行が在っても二重に出さない', () => {
    const rows = archiveRows([dir('写真/'), file('写真/海.jpg')]);
    expect(rows.map((r) => r.path)).toEqual(['写真', '写真/海.jpg']);
  });
});

describe('選ぶ', () => {
  const ENTRIES = [file('a.txt'), file('写真/海.jpg'), file('写真/2026/山.jpg')];

  it('押すと付き、もう一度押すと外れる', () => {
    expect(toggleArchiveMark(toggleArchiveMark([], 'a.txt'), 'a.txt')).toEqual([]);
  });

  it('file を選ぶとその 1 件', () => {
    expect(markedFiles(ENTRIES, ['a.txt']).map((e) => e.name)).toEqual(['a.txt']);
  });

  /** 🔴 user の言葉「階層の異なる複数のファイルを指定して」の実体。 */
  it('🔴 フォルダを選ぶと、その下の file が全部入る(孫も)', () => {
    expect(markedFiles(ENTRIES, ['写真']).map((e) => e.name)).toEqual([
      '写真/海.jpg',
      '写真/2026/山.jpg',
    ]);
  });

  it('フォルダと、その中の file を両方選んでも 1 件', () => {
    expect(markedFiles(ENTRIES, ['写真', '写真/海.jpg']).map((e) => e.name)).toEqual([
      '写真/海.jpg',
      '写真/2026/山.jpg',
    ]);
  });

  /** ⚠ 名前の**前方一致**で拾わない(`写真2` は `写真` の下ではない)。 */
  it('似た名前のフォルダを巻き込まない', () => {
    expect(markedFiles([file('写真2/別.jpg')], ['写真'])).toEqual([]);
  });

  it('フォルダそのものは取り出さない', () => {
    expect(markedFiles([dir('写真/'), file('写真/海.jpg')], ['写真']).map((e) => e.name)).toEqual([
      '写真/海.jpg',
    ]);
  });
});

describe('取り出した物の名前', () => {
  it('普段は末尾の名前だけ', () => {
    expect(extractNames(['写真/2026/海.jpg'])).toEqual(['海.jpg']);
  });

  /** 🔴 ぶつかったときだけ場所を混ぜる ── 上書きも取り違えも起こさない。 */
  it('同じ名前がぶつかったときだけ長くする', () => {
    expect(extractNames(['a/海.jpg', 'b/海.jpg', 'c/山.jpg'])).toEqual([
      'a-海.jpg',
      'b-海.jpg',
      '山.jpg',
    ]);
  });

  it('名前に / を残さない(添付の名前は 1 段)', () => {
    expect(extractNames(['a/x.txt', 'b/x.txt']).every((n) => !n.includes('/'))).toBe(true);
  });

  it('入力と同じ件数・同じ並びで返る(添字で対応づけられる)', () => {
    const paths = ['z/1.txt', 'a/2.txt', 'q/1.txt'];
    expect(extractNames(paths)).toHaveLength(paths.length);
    expect(extractNames(paths)[1]).toBe('2.txt');
  });
});
