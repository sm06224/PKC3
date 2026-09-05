/**
 * 🔴 **ボタンの帯 2 本(本文の帯 / 書式パネル)の下地と区切り**(#705 ②)── CSS を構文で pin。
 *
 * 直す前は `gap: 1px` + 下地 `--border` で線を作り、余りを `::after` で地の色に塗っていた。
 * `::after` は最後の段にしか居ないので、2 段以上に折れると上の段の余りが**線色のベタ塗り**
 * になった(スマホ・狭い窓)。⚠ 実ブラウザの画素は `tests/smoke/phone.smoke.spec.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const BARS = ["[data-pkc-field='detail-toolbar']", "[data-pkc-region='format-bar']"] as const;
const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('帯の下地は地の色、区切りはボタンの輪(#705 ②)', () => {
  it('🔴 2 本とも下地が --surface で、--border の下地を持たない ── 余りが灰色にならない', () => {
    const text = css();
    for (const sel of BARS) {
      const b = blocksFor(text, sel);
      expect(b.length, `${sel} の規則が無い(空振り)`).toBeGreaterThan(0);
      const joined = b.join('\n');
      expect(joined, `${sel} の下地が地の色でない`).toMatch(decl('background', 'var\\(--surface\\)'));
      expect(joined, `${sel} の下地が線色(余りがベタ塗りになる)`).not.toMatch(decl('background', 'var\\(--border\\)'));
      // 折り返す(主要な導線を畳まない)── 折り返すからこそ余りの色が効く
      expect(joined, `${sel} が折り返さない`).toMatch(decl('flex-wrap', 'wrap'));
      // ⚠ 埋め草の `::after` は要らなくなったので残さない(残すと「最後の段だけ地の色」の名残)
      expect(blocksFor(text, `${sel}::after`), `${sel}::after の埋め草が残っている`).toHaveLength(0);
    }
  });

  it('🔴 区切りは各ボタンの 1px の輪 ── 焦点の輪(:focus-visible)は殺さない', () => {
    const text = css();
    for (const sel of BARS) {
      const b = blocksFor(text, `${sel} button:not(:focus-visible)`);
      expect(b.length, `${sel} のボタンに区切りの輪が無い(ボタンがくっついて 1 枚に見える)`).toBeGreaterThan(0);
      expect(b.join('\n'), `${sel} の輪が 1px の線色でない`).toMatch(decl('outline', '1px solid var\\(--border\\)'));
      // ⚠ `:focus-visible` を外した素の button に outline を書くと、共通の焦点の輪(2px accent)を上書きする
      expect(blocksFor(text, `${sel} button`).join('\n'), `${sel} button に outline が在る(焦点の輪を殺す)`).not.toMatch(
        decl('outline', '.*'),
      );
    }
  });

  it('🔴 2 本は 1 つの規則を共有している(片方だけ直る日を作らない)', () => {
    const text = css();
    const shared = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' ')))
      .filter((sels) => BARS.every((b) => sels.includes(b)));
    expect(shared.length, '2 本を同時に指す規則が無い(下地の規則が 2 か所に割れている)').toBeGreaterThan(0);
  });
});
