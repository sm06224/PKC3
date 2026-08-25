/**
 * 🔴 **スニペットの展開**(#196 / B-2)。
 *
 * ⚠ 見るのは 4 つ:① **動的値は 4 つだけ** ② **埋める印は残る**(印のまま選ぶ)
 * ③ **次の場所はそのつど探す**(位置を覚えない)④ **既存の本文の読みを変えない**。
 */
import { describe, expect, it } from 'vitest';
import {
  fillSnippetVars,
  insertSnippet,
  nextSnippetSlot,
  snippetSlots,
  SNIPPET_VARS,
} from '../../src/features/snippet/snippet-expand';

/** 2026-08-25(火)14:30 固定。⚠ 時計は読まない(test が実行した日で変わらない)。 */
const NOW = new Date(2026, 7, 25, 14, 30, 0);

describe('動的値(4 つだけ)', () => {
  it('日付は本文の @ 記法と同じ形(YYYY-MM-DD)', () => {
    expect(fillSnippetVars('今日は ${date} です', NOW).text).toBe('今日は 2026-08-25 です');
  });

  it('時刻と日時', () => {
    expect(fillSnippetVars('${time}', NOW).text).toBe('14:30');
    expect(fillSnippetVars('${datetime}', NOW).text).toBe('2026-08-25 14:30');
  });

  /**
   * 🔴 **`@${date}` がそのまま予定になる**ことを見る ── これが `YYYY-MM-DD` を
   * 選んだ理由なので、形が変わったらここで落ちる。
   */
  it('🔴 予定の記法に嵌まる形で出る', () => {
    expect(fillSnippetVars('- [ ] 締切 @${date}', NOW).text).toBe('- [ ] 締切 @2026-08-25');
  });

  it('${cursor} は消えて、位置が返る', () => {
    const r = fillSnippetVars('拝啓 ${cursor} 敬具', NOW);
    expect(r.text).toBe('拝啓  敬具');
    expect(r.caret).toBe(3);
  });

  it('⚠ ${cursor} が 2 つあれば、後ろのものは印として残る(勝手に選ばない)', () => {
    const r = fillSnippetVars('a${cursor}b${cursor}c', NOW);
    expect(r.text).toBe('ab${cursor}c');
    expect(r.caret).toBe(1);
  });

  it('⚠ 表に無い名前は埋めない(埋める印として残る)', () => {
    expect(fillSnippetVars('${宛名} 様', NOW).text).toBe('${宛名} 様');
    expect(fillSnippetVars('${year}', NOW).text).toBe('${year}');
  });

  it('表は 4 つで、増えていない', () => {
    expect([...SNIPPET_VARS]).toEqual(['date', 'time', 'datetime', 'cursor']);
  });
});

describe('埋める印の走査', () => {
  it('前から順に拾う', () => {
    expect(snippetSlots('${甲} と ${乙}').map((s) => s.label)).toEqual(['甲', '乙']);
  });

  it('🔴 範囲は括弧ごと(打てば印ごと置き換わる)', () => {
    const [s] = snippetSlots('x ${甲} y');
    expect('x ${甲} y'.slice(s!.start, s!.end)).toBe('${甲}');
  });

  it('⚠ 動的値は印にしない(挿した時点で字になっている)', () => {
    expect(snippetSlots('${date} ${宛名}').map((s) => s.label)).toEqual(['宛名']);
  });

  it('⚠ 改行を跨がない(閉じ忘れが本文を飲み込まない)', () => {
    expect(snippetSlots('${甲\n乙}')).toEqual([]);
  });

  it('⚠ 空の ${} は印にしない(選んでも何も示さない)', () => {
    expect(snippetSlots('${}')).toEqual([]);
  });
});

describe('次の場所(Tab)', () => {
  const TEXT = 'a ${甲} b ${乙} c';

  it('カーソルより後ろの最初の印', () => {
    expect(nextSnippetSlot(TEXT, 0)?.label).toBe('甲');
    expect(nextSnippetSlot(TEXT, 3)?.label).toBe('乙');
  });

  it('🔴 無ければ null(呼び側は Tab を素通しする)', () => {
    expect(nextSnippetSlot(TEXT, 20)).toBe(null);
    expect(nextSnippetSlot('印は無い', 0)).toBe(null);
  });

  /**
   * 🔴 **位置を覚えない**ことを見る ── 間に字を打っても、次の印を正しく指す。
   * ⚠ 覚える実装だと、ここで 1 文字ぶんずれる(いちばん静かな壊れ方)。
   */
  it('🔴 間に打っても、次の印を正しく指す', () => {
    const typed = 'a 山田 b ${乙} c'; // `${甲}` を「山田」で置き換えた後
    const at = typed.indexOf('山田') + 2;
    expect(nextSnippetSlot(typed, at)?.label).toBe('乙');
    expect(typed.slice(nextSnippetSlot(typed, at)!.start, nextSnippetSlot(typed, at)!.end)).toBe(
      '${乙}',
    );
  });
});

describe('挿す', () => {
  const sel = (text: string, start: number, end = start) => ({ text, start, end });

  it('選択位置へ入り、最初の印が選ばれる', () => {
    const r = insertSnippet(sel('AB', 1), '${甲}です', NOW);
    expect(r.text).toBe('A${甲}ですB');
    expect(r.text.slice(r.start, r.end)).toBe('${甲}');
  });

  it('印が無く ${cursor} が在れば、そこにカーソル(選択は空)', () => {
    const r = insertSnippet(sel('AB', 1), '拝啓${cursor}敬具', NOW);
    expect(r.text).toBe('A拝啓敬具B');
    expect(r.start).toBe(r.end);
    expect(r.text.slice(0, r.start)).toBe('A拝啓');
  });

  it('どちらも無ければ、挿した後ろにカーソル', () => {
    const r = insertSnippet(sel('AB', 1), 'XY', NOW);
    expect(r.text).toBe('AXYB');
    expect(r.start).toBe(3);
    expect(r.end).toBe(3);
  });

  it('🔴 選択していた字は置き換わる(選んでから挿せる)', () => {
    const r = insertSnippet(sel('A消すB', 1, 3), 'XY', NOW);
    expect(r.text).toBe('AXYB');
  });

  it('動的値は挿すときに埋まる', () => {
    expect(insertSnippet(sel('', 0), '@${date}', NOW).text).toBe('@2026-08-25');
  });
});

/**
 * 🔴 **既に配ってある本文の意味を変えない** ── これが `$` を選んだ前提である。
 * ⚠ 展開は**挿すときだけ**走るので、普通のノートに `${date}` と書いても
 *   描画は 1 バイトも変わらない(ここでは「純関数を呼ばなければ何も起きない」を pin する)。
 */
describe('⚠ 対照群 ── 本文をそのまま持っていても何も起きない', () => {
  it('走査は本文を書き換えない', () => {
    const body = '価格は ${price} 円 / ${date}';
    snippetSlots(body);
    nextSnippetSlot(body, 0);
    expect(body).toBe('価格は ${price} 円 / ${date}');
  });
});
