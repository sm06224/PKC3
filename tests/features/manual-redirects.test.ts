/** @vitest-environment happy-dom */
/**
 * 旧マニュアルの章の印 → いまの見出し(#779 段⑨)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MANUAL_HEADING_REDIRECTS } from '../../src/features/help/manual-redirects';
import { manualHeadingSlug } from '../../src/features/help/manual-doc';
import { buildManualPage } from '../../src/features/help/manual-page';
import { refKey } from '../../src/features/help/manual-refs';

const heads = (() => {
  let fence = false;
  const hs: { level: number; text: string }[] = [];
  for (const l of readFileSync('docs/manual.md', 'utf-8').split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6}) (.*)$/.exec(l);
    if (m) hs.push({ level: m[1]!.length, text: m[2]! });
  }
  return hs;
})();
const slugs = new Set(heads.filter((h) => h.level <= 3).map((h) => manualHeadingSlug(refKey(h.text))));

// 旧 H2(git の origin/main 時点の章)── 鍵はこの字から作った id
const OLD_H2 = [
  'はじめる', '作る・開く', '書く', '本文に書けるもの(記法)', '探す・数える', '整理する',
  '画面を組み替える', 'システム', '右クリックでできること', '添付する・貼り付ける', 'ランチャー',
  '出す・取り込む', '予定を扱う', '音と動画を扱う', '連絡先を扱う', 'スマホ・タッチで使う',
  'お知らせと更新', '言葉の意味(用語集)', '困ったとき', 'ショートカットキー',
];

describe('旧い章の印の行き先', () => {
  it('🔴 行き先の対応は、この表のとおり(実装の表から期待値を作らない)', () => {
    expect({ ...MANUAL_HEADING_REDIRECTS }).toEqual({
      はじめる: 'はじめに',
      '作る-開く': 'ノートの作成と編集',
      書く: 'ノートの作成と編集',
      '本文に書けるもの-記法': 'Markdown と拡張記法',
      '探す-数える': '整理と検索',
      整理する: '整理と検索',
      画面を組み替える: '画面のカスタマイズ',
      システム: 'メッセージ・通知・設定',
      右クリックでできること: '右クリックメニューの項目',
      '添付する-貼り付ける': '添付ファイルとメディア',
      ランチャー: '組み込みアプリとランチャー',
      '出す-取り込む': '書き出し・取り込み・バックアップ',
      予定を扱う: '予定とタスク',
      音と動画を扱う: '添付ファイルとメディア',
      連絡先を扱う: '付箋ボードと連絡先',
      'スマホ-タッチで使う': 'スマートフォン・タブレット',
      困ったとき: 'リファレンスと困ったときの対処',
    });
  });

  it('🔴 行き先はどれも、いまの H1〜H3 の見出し(id が焼かれる深さ)', () => {
    for (const [old, now] of Object.entries(MANUAL_HEADING_REDIRECTS)) {
      expect(slugs.has(manualHeadingSlug(now)), `「${old}」の行き先「${now}」が見出しに無い`).toBe(true);
    }
  });

  it('🔴 鍵はいまの見出しに当たらない(当たるなら表が要らない)', () => {
    for (const old of Object.keys(MANUAL_HEADING_REDIRECTS)) {
      expect(slugs.has(old), `「${old}」はいまも見出しの id として在る`).toBe(false);
    }
  });

  it('🔴 旧 H2 は全部、表の鍵かいまの見出しのどちらかに当たる(漏れ無し)', () => {
    for (const h of OLD_H2) {
      const id = manualHeadingSlug(h);
      expect(
        id in MANUAL_HEADING_REDIRECTS || slugs.has(id),
        `旧い章「${h}」が行き先を持たない`,
      ).toBe(true);
    }
    // 空振り防止 ── 表の鍵は旧 H2 の id と一致している
    expect(Object.keys(MANUAL_HEADING_REDIRECTS).sort()).toEqual(
      OLD_H2.map(manualHeadingSlug).filter((id) => !slugs.has(id)).sort(),
    );
  });

  it('🔴 窓の script に表が焼かれ、旧い印で新しい見出しへ送られる', () => {
    const page = buildManualPage({
      title: 't', version: 'v', tag: 'x', sections: [], tokensCss: ':root{}', bodyCss: '',
      themeStorageKey: 'k', textScaleStorageKey: 'k2',
      html: '<h2>はじめに</h2><p>a</p><h2>ノートの作成と編集</h2><p>b</p>',
    });
    const m = /<script>([\s\S]*?)<\/script>/u.exec(page.html);
    expect(m, 'script が無い').not.toBeNull();
    const script = m![1]!;
    expect(script).toContain(JSON.stringify(manualHeadingSlug('ノートの作成と編集')));
    // 実際に走らせる ── 旧い印で開くと新しい見出しが scrollIntoView される
    const hit: string[] = [];
    for (const el of Array.from(document.querySelectorAll('h2'))) el.remove();
    for (const [id, text] of [['はじめに', 'はじめに'], ['ノートの作成と編集', 'x']] as const) {
      const h = document.createElement('h2');
      h.id = id;
      h.textContent = text;
      h.scrollIntoView = () => void hit.push(h.id);
      document.body.appendChild(h);
    }
    history.replaceState(null, '', '/manual.html#' + encodeURIComponent('作る-開く'));
    new Function(script)();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('DOMContentLoaded'));
    expect(hit).toEqual(['ノートの作成と編集']);
  });
});
