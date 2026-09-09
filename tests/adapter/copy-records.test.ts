/** @vitest-environment node */
/**
 * コピーが**必ず履歴へ積まれる**こと(#678)。
 *
 * 🔴 ここで守るのは **「口を通らない経路が生えていないこと」**である。
 * コピーの口は `platform/clipboard.ts` の 2 つだけで、そこに 13 か所が集まっている ──
 * ⚠ 誰かが `navigator.clipboard.writeText` を**直に**呼ぶ 1 行を足した日、
 * その経路は**黙って履歴に載らなくなる**(画面は何も変わらないので、誰も気づけない)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codeOnly } from '../helpers/code-only';

const SRC = 'src';

/** `src` の中の .ts を全部読む。 */
function allSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push({ path: p, text: readFileSync(p, 'utf-8') });
    }
  };
  walk(SRC);
  return out;
}

describe('🔴 コピーの口を迂回していない(#678)', () => {
  const files = allSources();

  it('空振り防止 ── src の .ts を実際に読めている', () => {
    expect(files.length, 'src を 1 file も読んでいない').toBeGreaterThan(100);
  });

  it('🔴 `navigator.clipboard` を触るのは、口の file だけ', () => {
    // ⚠ **コメントを落としてから見る** ── 注釈で満たされると、
    //    受け口をコメントアウトしても緑になる(CLAUDE.md §1)
    const offenders = files
      .filter((f) => !f.path.endsWith(join('platform', 'clipboard.ts')))
      .filter((f) => /navigator\s*\.\s*clipboard/.test(codeOnly(f.text)))
      .map((f) => f.path);
    expect(
      offenders,
      '口を通らないコピーが在る ── その経路は履歴に載らない(画面は何も変わらないので気づけない)',
    ).toEqual([]);
  });

  it('🔴 口の file は、実際に `navigator.clipboard` を使っている(空振り防止)', () => {
    const mouth = files.find((f) => f.path.endsWith(join('platform', 'clipboard.ts')));
    expect(mouth, '口の file が見つからない(改名した?)').toBeDefined();
    expect(/navigator\s*\.\s*clipboard/.test(codeOnly(mouth!.text))).toBe(true);
  });
});

/**
 * 🔴 **本物どうしを繋いで見る**(CLAUDE.md §7「A と B が合意していることは、
 * A の test にも B の test にも書けない」)。
 *
 * ⚠ 上の走査は「口の外で叩いていない」しか見ていない ── **口が実際に積むか**は
 * 別の主張である。ここは実物の `copyPlainText` / `copyMarkdownAndHtml` を呼んで、
 * 積まれた物を受け取る。
 */
describe('🔴 コピーすると、実際に積まれる', () => {
  it('字だけのコピーが積まれる / 失敗した回は積まれない', async () => {
    const { copyPlainText, setCopyRecorder } = await import(
      '../../src/adapter/platform/clipboard'
    );
    const got: { text: string; html: string }[] = [];
    const undo = setCopyRecorder((i) => got.push({ text: i.text, html: i.html }));
    try {
      // ① 写せた回 ── 積まれる
      vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.resolve() } });
      expect(await copyPlainText('ひとつめ')).toBe(true);
      expect(got.map((c) => c.text), '写せたのに積まれていない').toEqual(['ひとつめ']);

      // ② 🔴 **写せなかった回は積まない**(押しても貼れない行を並べない)
      //    ⚠ document も外す ── legacy の execCommand へ落ちると true になりうる
      vi.stubGlobal('navigator', {
        clipboard: { writeText: () => Promise.reject(new Error('no')) },
      });
      vi.stubGlobal('document', undefined);
      expect(await copyPlainText('ふたつめ')).toBe(false);
      expect(got.map((c) => c.text), '写せていないのに積んでいる').toEqual(['ひとつめ']);
    } finally {
      vi.unstubAllGlobals();
      undo();
    }
  });

  it('🔴 rich で写せた回は html つきで積み、落ちた回は 1 度だけ積む(二重にしない)', async () => {
    const { copyMarkdownAndHtml, setCopyRecorder } = await import(
      '../../src/adapter/platform/clipboard'
    );
    const got: { text: string; html: string }[] = [];
    const undo = setCopyRecorder((i) => got.push({ text: i.text, html: i.html }));
    try {
      // ① rich が通った回 ── html が残る
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor() {}
        },
      );
      vi.stubGlobal('Blob', class {});
      vi.stubGlobal('navigator', { clipboard: { write: () => Promise.resolve() } });
      expect(await copyMarkdownAndHtml('**md**', '<b>md</b>')).toBe(true);
      expect(got, 'html が落ちている').toEqual([{ text: '**md**', html: '<b>md</b>' }]);

      // ② 🔴 rich が落ちて plain へ回った回 ── **1 度だけ**積まれる
      got.length = 0;
      vi.stubGlobal('navigator', {
        clipboard: {
          write: () => Promise.reject(new Error('no')),
          writeText: () => Promise.resolve(),
        },
      });
      expect(await copyMarkdownAndHtml('あとで', '<i>あとで</i>')).toBe(true);
      expect(got, '二重に積んでいる(または積んでいない)').toEqual([
        { text: 'あとで', html: '' },
      ]);
    } finally {
      vi.unstubAllGlobals();
      undo();
    }
  });
});
