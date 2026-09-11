/**
 * 🔴 **録ったものの拾い方**(#683 段①、2026-09-09)。
 *
 * ⚠ ここが守るのは 1 つ:**見分けるのは `attachment.mime` であって拡張子ではない**。
 *   拡張子で絞ると `.ogg` / `.m4a` / `.mkv` が一覧から消えるが、
 *   **0 件は「まだ録っていない」と読める**ので、user には「録音が消えた」に見える
 *   (いちばん気づけない壊れ方)。
 */
import { describe, expect, it } from 'vitest';
import {
  captureItemLabel,
  captureItemsFrom,
  captureKindOf,
  visibleCaptures,
  type CaptureSource,
} from '@features/capture/capture-item';
import { CAPTURE_MIME_EXT } from '@features/asset/capture-text';

/** 添付ノートの本文(`attachment-flavor.ts` が書く形と同じ)。 */
function attach(name: string, mime: string, size = 1234): string {
  return [
    '---',
    `attachment.name: ${name}`,
    `attachment.mime: ${mime}`,
    `attachment.size: ${String(size)}`,
    'attachment.asset_key: k-1',
    '---',
    '',
  ].join('\n');
}

const src = (lid: string, title: string, body: string): CaptureSource => ({ lid, title, body });

describe('録ったものの見分け(#683 段①)', () => {
  /**
   * 🔴 **収録が出しうる型は、全部「音か動画」に見える**。
   * 🔑 母集団は `capture-text.ts` の表から採る(手で写した一覧を並べると、
   *   表ごと消す変異が生き延びる ── `ext-mime-parity.test.ts` と同じ作法)。
   */
  it('🔴 収録が出しうる MIME は、1 つ残らず一覧に入る', () => {
    const mimes = Object.keys(CAPTURE_MIME_EXT);
    // 空振り防止 ── 表が空になっていないこと
    expect(mimes.length, '収録の表が空(前処理が壊れている)').toBeGreaterThan(4);
    const missed = mimes.filter((m) => captureKindOf(m) === null);
    expect(missed, '収録できるのに一覧に出ない型がある(録音が消えたように見える)').toEqual([]);
  });

  /**
   * ⚠ **引数付きの mime がそのまま frontmatter に入りうる** ──
   *   `MediaRecorder` は `audio/webm;codecs=opus` を返す。
   */
  it('🔴 `;codecs=…` が付いていても見分けられる', () => {
    expect(captureKindOf('audio/webm;codecs=opus')).toBe('audio');
    expect(captureKindOf('video/webm; codecs="vp8,opus"')).toBe('video');
  });

  /**
   * 🔴 **前後の空白と大文字で答えが変わらない**(2026-09-09、変異試験 C2)。
   * ⚠ 1 稿目は「`;` の前だけを見る」ことを守っているつもりだったが、
   *   見ているのは**頭**なので `;` の切り出しは **no-op** だった ──
   *   本当に効いているのはこの 2 つである(外すとここで落ちる)。
   */
  it('🔴 前の空白・大文字で答えが変わらない', () => {
    expect(captureKindOf(' audio/webm'), '前の空白で落ちる').toBe('audio');
    expect(captureKindOf('AUDIO/MP4'), '大文字で落ちる').toBe('audio');
    expect(captureKindOf('\tVideo/MP4 '), 'タブと後ろの空白で落ちる').toBe('video');
  });

  /** 🔴 **対照群** ── 音でも動画でもない添付は入らない(画像・PDF・Office)。 */
  it('🔴 音でも動画でもない添付は入らない', () => {
    for (const m of ['image/png', 'application/pdf', 'text/plain', '', 'audiobook/x'])
      expect(captureKindOf(m), `${m} が一覧に入っている`).toBeNull();
  });

  it('🔴 拡張子ではなく中身で拾う(名前を .txt に直しても並ぶ)', () => {
    const got = captureItemsFrom([
      src('a', 'メモ.txt', attach('メモ.txt', 'audio/ogg')),
      src('b', '写真.webm', attach('写真.webm', 'image/png')),
    ]);
    expect(got.map((i) => i.lid), '拡張子で絞っている').toEqual(['a']);
  });

  it('🔴 並びは渡された順のまま(面ごとに別の順にしない)', () => {
    const got = captureItemsFrom([
      src('c', 'c.webm', attach('c.webm', 'audio/webm')),
      src('a', 'a.webm', attach('a.webm', 'audio/webm')),
      src('b', 'b.webm', attach('b.webm', 'video/webm')),
    ]);
    expect(got.map((i) => i.lid)).toEqual(['c', 'a', 'b']);
  });

  it('⚠ `attachment.name` が空なら題名を使う(名前の無い行を出さない)', () => {
    const body = ['---', 'attachment.mime: audio/webm', '---', ''].join('\n');
    const got = captureItemsFrom([src('a', '題名だけ', body)]);
    expect(got[0]?.name).toBe('題名だけ');
    // ⚠ 中身の鍵が無い添付も**一覧には出す**(「聞く」が出ないだけ ── 名前と大きさは読める)
    expect(got[0]?.assetKey, '鍵の無い行を落としている').toBeNull();
  });

  describe('呼び名', () => {
    /**
     * ⚠ **「録音」と言い切らない** ── 外から取り込んだ音もここへ来るので、
     *   出所は区別できない。🔑 名前が収録の形のときだけ収録の呼び名を使う。
     */
    it('🔴 収録の名前なら収録の呼び名、そうでなければ 音 / 動画', () => {
      const items = captureItemsFrom([
        src('a', 'x', attach('録音-2026-09-09-030102.webm', 'audio/webm')),
        src('b', 'y', attach('画面収録-2026-09-09-030102.webm', 'video/webm')),
        src('c', 'z', attach('会議.m4a', 'audio/mp4')),
        src('d', 'w', attach('旅行.mp4', 'video/mp4')),
      ]);
      expect(items.map(captureItemLabel)).toEqual(['録音', '画面収録', '音', '動画']);
    });
  });

  describe('絞り込み', () => {
    const items = captureItemsFrom([
      src('a', 'x', attach('録音-2026-09-09-030102.webm', 'audio/webm')),
      src('b', '会議の記録', attach('mtg.m4a', 'audio/mp4')),
    ]);

    it('⚠ 空の絞りは全部返す(写しを返す ── 元の配列を書き換えない)', () => {
      const got = visibleCaptures(items, '  ');
      expect(got).toHaveLength(2);
      got.pop();
      expect(items, '元の一覧を書き換えている').toHaveLength(2);
    });

    it('🔴 名前でも題名でも当たる(どちらか片方だと「無い」に見える)', () => {
      expect(visibleCaptures(items, '録音').map((i) => i.lid)).toEqual(['a']);
      expect(visibleCaptures(items, '会議').map((i) => i.lid)).toEqual(['b']);
      // ⚠ 大文字小文字は無視(題名の絞りと同じ規則)
      expect(visibleCaptures(items, 'MTG').map((i) => i.lid)).toEqual(['b']);
      // 対照群 ── 当たらない字では 0 件
      expect(visibleCaptures(items, 'ぜったい無い')).toEqual([]);
    });
  });
});
