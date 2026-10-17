/** @vitest-environment node */
/**
 * 🔴 テンプレートの `${date}` などを、日本語入力のまま打った全角 `＄｛date｝` でも展開する(#1163 依頼 152。Gemini 回答は案どおり)。
 *
 * ⚠ 半角の動きは 1 つも変えない(対照群)。⚠ 全角の「埋める印」(`＄｛宛名｝`)は印のまま残り、選ばれる。
 */
import { describe, expect, it } from 'vitest';
import {
  fillSnippetVars,
  insertSnippet,
  nextSnippetSlot,
  snippetSlots,
} from '../../src/features/snippet/snippet-expand';

const NOW = new Date(2026, 7, 25, 14, 30, 0);

describe('全角の動的値', () => {
  it.each([
    ['＄｛date｝', '2026-08-25'],
    ['＄｛time｝', '14:30'],
    ['＄｛datetime｝', '2026-08-25 14:30'],
    // 中身まで全角で打った場合
    ['＄｛ｄａｔｅ｝', '2026-08-25'],
    // 半角と全角が混ざった打ち方
    ['${date｝', '2026-08-25'],
    ['＄{date}', '2026-08-25'],
  ])('%s → %s', (src, want) => {
    expect(fillSnippetVars(`日付: ${src} です`, NOW).text).toBe(`日付: ${want} です`);
  });

  it('全角の ＄｛cursor｝ は消えて、そこにカーソルが来る', () => {
    const r = fillSnippetVars('あ＄｛cursor｝い', NOW);
    expect(r.text).toBe('あい');
    expect(r.caret).toBe(1);
  });

  it('コードの中の全角は、半角と同じく値にしない', () => {
    const r = fillSnippetVars('```\n＄｛date｝\n```\n＄｛date｝', NOW);
    expect(r.text).toBe('```\n＄｛date｝\n```\n2026-08-25');
  });
});

describe('全角の埋める印', () => {
  it('＄｛宛名｝ は印のまま残り、挿した直後に選ばれる(中身は user の字のまま)', () => {
    const body = '拝啓 ＄｛宛名｝ 様';
    expect(snippetSlots(body).map((s) => s.label)).toEqual(['宛名']);
    const r = insertSnippet({ text: '', start: 0, end: 0 }, body, NOW);
    expect(r.text).toBe(body);
    expect(r.text.slice(r.start, r.end)).toBe('＄｛宛名｝');
    expect(nextSnippetSlot(body, 0)?.label).toBe('宛名');
  });

  it('全角の動的値の名前は、印として数えない(挿した後に手で書かれても選ばれない)', () => {
    expect(snippetSlots('＄｛date｝ ＄｛ｔｉｍｅ｝')).toEqual([]);
  });

  it('⚠ 対照群 ── 半角の ${宛名} は今までどおり / 閉じ忘れは印にならない', () => {
    expect(snippetSlots('${宛名}').map((s) => s.label)).toEqual(['宛名']);
    expect(snippetSlots('＄｛閉じ忘れ\n次の行｝')).toEqual([]);
    expect(snippetSlots('＄｛｝')).toEqual([]);
  });
});
