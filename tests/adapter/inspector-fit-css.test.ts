/**
 * 🔴 **右の列の中身が右端で切れない**(#700)── CSS を構文で pin。
 *
 * 1280〜1366 幅では右の列が下限の 220px になり、タグの行の「欄 + ボタン」(196px)が
 * `dl` の `1fr`(= `minmax(auto, 1fr)`)の下限になって **dd 全部が 41px はみ出し**、
 * 「+ タグを足す」が画面の外で切れていた。⚠ 実ブラウザで「1 つもはみ出していない」は
 * `tests/smoke/inspector-fit.smoke.spec.ts` が全数で見る ── ここは規則の在処だけ。
 * ⚠ `dd { min-width: 0 }` は置いていない ── 変異試験で外しても smoke が 1 px も違わず
 *   (各 dd の min-content の最大は 98px)、「これが無いと壊れる」と言えなかった。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('右の列のタグの行は折り返す(#700)', () => {
  it('🔴 タグを足す欄の組(tag-add)は折り返す ── 組の幅が dd 全部の下限にならない', () => {
    const text = css();
    // ⚠ 前提: dl は `auto 1fr` の grid(1fr の下限が中身、という話はここから来る)
    const dl = blocksFor(text, "[data-pkc-region='inspector'] dl").join('\n');
    expect(dl, 'dl が grid でない(前提が変わった ── この検査を見直す)').toMatch(decl('grid-template-columns', 'auto 1fr'));
    const b = blocksFor(text, "[data-pkc-field='tag-add']");
    expect(b.length, 'tag-add の規則が無い(空振り)').toBeGreaterThan(0);
    expect(b.join('\n'), '欄とボタンの組が折り返さない(右の列が 41px はみ出す)').toMatch(decl('flex-wrap', 'wrap'));
  });
});
