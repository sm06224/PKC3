/** @vitest-environment happy-dom */
/**
 * 🔴 **クリップボードの `text/html` を、そのまま ` ```html ` の囲みにする**
 * (user 要望 2026-08-27)。
 *
 * > 「コピーしたクリップボードを解析すると **utf-8 の html の格納と文字列としての
 * > 格納の 2 種類**がありました / **html のフェンスとしてそれを貼付できれば良い**
 * > のだと思います」
 *
 * ## ⚠ これは `convertPastedHtml`(markdown へ戻す)の**代わりではない**
 *
 * 実測では、変換はコードフェンス・入れ子リスト・表・太字とも**正しく戻る**。
 * 落ちるのは **markdown に無い形**(色・段組・SVG)だけである ──
 * だから囲みは**設定で選んだときだけ**通る 5 番目の口である。
 */
import { describe, expect, it } from 'vitest';
import {
  pastedHtmlFence,
} from '../../src/features/markdown/html-to-markdown';
import { choosePaste } from '../../src/features/markdown/paste-source';

describe('html をそのまま囲みにする', () => {
  it('🔴 ` ```html ` の囲みになり、中身は 1 文字も変えない', () => {
    const out = pastedHtmlFence('<div style="color:red">あか</div>');
    expect(out).toBe('```html\n<div style="color:red">あか</div>\n```');
  });

  /**
   * ⚠ Chromium はクリップボードの HTML に `<meta charset>` を**必ず前置する**。
   * 箱は `srcdoc` で描くので効かないうえ、本文に残ると読みにくい。
   */
  it('⚠ 先頭の `<meta charset>` は落とす(本文に残さない)', () => {
    const out = pastedHtmlFence(`<meta charset='utf-8'><p>本文</p>`);
    expect(out).toBe('```html\n<p>本文</p>\n```');
  });

  /** 🔑 **先頭の 1 つだけ** ── 途中に在るものは user の中身である。 */
  it('🔑 途中の `<meta charset>` は残す(user の中身かもしれない)', () => {
    const out = pastedHtmlFence(`<p>a</p><meta charset='utf-8'><p>b</p>`);
    expect(out).toContain("<meta charset='utf-8'>");
  });

  /**
   * 🔴 **これが無いと囲みが途中で終わる。**
   * ⚠ AI の返答は markdown の説明を含むことがあり、HTML の中に ``` が入る。
   */
  it('🔴 中身に ``` が在れば、囲みを長くする', () => {
    const out = pastedHtmlFence('<pre>```bash\nls\n```</pre>')!;
    expect(out.startsWith('````html\n'), `囲みが伸びていない: ${out.slice(0, 12)}`).toBe(true);
    expect(out.endsWith('\n````')).toBe(true);
    // ⚠ 空振り防止 ── 中身の ``` がそのまま在ること(囲みだけ伸ばして中身を削らない)
    expect(out).toContain('```bash');
  });

  it('⚠ もっと長い連にも勝つ', () => {
    const out = pastedHtmlFence('<p>`````</p>')!;
    expect(out.startsWith('``````html\n')).toBe(true);
  });

  it('⚠ 空 / 空白だけなら囲みを作らない(空の箱を本文に置かない)', () => {
    expect(pastedHtmlFence('')).toBeNull();
    expect(pastedHtmlFence(`  <meta charset='utf-8'>  `)).toBeNull();
  });

  /**
   * 🔴 **大きくても囲みにする**(#492。user 指示 2026-08-27)。
   * ⚠ かつて 1MB を超えると囲みにもせず平文へ落としていた ──
   *   この設定を選ぶ user は「変換すると落ちるものが在る」と言っているのだから、
   *   **大きいページこそ**囲みにしたい相手である。
   */
  it('🔴 1MB を超えるものでも囲みにする(旧上限を撤廃した)', () => {
    const OLD_CAP = 1024 * 1024; // ⚠ 旧 `PASTE_HTML_MAX`(いまは存在しない)
    const html = '<p>' + 'x'.repeat(OLD_CAP) + '</p>';
    expect(html.length, '入力が旧上限を超えていない(空振り)').toBeGreaterThan(OLD_CAP);
    const out = pastedHtmlFence(html);
    expect(out, '大きいだけで囲みにしなかった').not.toBeNull();
    expect(out, '囲みの形になっていない').toContain('```');
  });
});

/** 設定でこの口が選ばれる経路。⚠ **判定は `choosePaste` の 1 か所**である。 */
describe('設定「ウェブページの形をそのまま」', () => {
  const run = (
    have: { html?: string | null; htmlFence?: string | null; rtf?: string | null },
    sizes = { html: 100, rtf: 200, plain: 50 },
  ) => {
    const called: string[] = [];
    return {
      ...choosePaste({
        source: 'html-fence',
        sizes,
        convert: {
          /** ⚠ ここでは試さない ── 段③ の検査は `paste-plain-table.test.ts` が持つ。 */
          plainTable: () => null,
          permalink: () => {
            called.push('permalink');
            return null;
          },
          html: () => {
            called.push('html');
            return have.html ?? null;
          },
          htmlFence: () => {
            called.push('htmlFence');
            return have.htmlFence ?? null;
          },
          rtf: () => {
            called.push('rtf');
            return have.rtf ?? null;
          },
        },
      }),
      called,
    };
  };

  it('🔴 囲みを使い、markdown への変換は 1 度も試さない', () => {
    const r = run({ htmlFence: '```html\n<p>a</p>\n```', html: '# 変換したもの' });
    expect(r.text).toBe('```html\n<p>a</p>\n```');
    expect(r.attempt.used).toBe('html-fence');
    // 🔴 **ここが肝** ── 変換を試すと、遅い解析が無駄に走るうえ
    //    「そのまま」と書いた設定の字が嘘になる
    expect(r.called, 'markdown への変換を試している').not.toContain('html');
  });

  /** ⚠ **理由を残す** ── 黙って平文に落ちると、user は設定が効いていないと思う。 */
  it('⚠ HTML が届いていなければ平文に落ち、理由が残る', () => {
    const r = run({}, { html: 0, rtf: 200, plain: 50 });
    expect(r.text).toBeNull();
    expect(r.attempt.used).toBe('plain');
    expect(r.attempt.skipped.map((s) => `${s.kind}:${s.why}`)).toContain('html:届いていません');
  });

  /**
   * 🔴 **大きさで断らない**(#492。user 指示 2026-08-27)。
   *
   * ⚠ ここは 2026-08-27 まで**逆のことを守っていた**(#487「大きすぎたときは、そう書く」)。
   *   user の指示はその手前で「**そもそも断るな**」である ── この設定を選ぶ user は
   *   「変換すると落ちるものが在る」と言っているのだから、**大きいページこそ**
   *   囲みにしたい相手である。
   * ⚠ **向きを裏返したので、見るものも裏返した** ── 「呼んでいない」ではなく
   *   **呼んで使ったこと**(`called` と `used`)を見る。
   */
  it('🔴 旧上限を超えていても、囲みにする', () => {
    const OLD_CAP = 1024 * 1024; // ⚠ 旧 `PASTE_HTML_MAX`(いまは存在しない)
    const r = run({ htmlFence: '```html\n<p>a</p>\n```' }, {
      html: OLD_CAP * 8,
      rtf: 0,
      plain: 50,
    });
    expect(r.attempt.used, '大きいだけで平文へ落とした').toBe('html-fence');
    expect(r.called, '囲みを組もうとしていない').toContain('htmlFence');
    expect(
      r.attempt.skipped.some((s) => s.why.includes('大きすぎ')),
      '大きさを理由に断っている',
    ).toBe(false);
  });

  it('⚠ 上限の内側で空だったときは「空」と書く(大きすぎ とは書かない)', () => {
    const r = run({ htmlFence: null }, { html: 100, rtf: 0, plain: 50 });
    expect(r.attempt.used).toBe('plain');
    const why = r.attempt.skipped.find((s) => s.kind === 'html')?.why ?? '';
    expect(why).toContain('空');
    expect(why, '読んでいないと誤解させる字が混ざっている').not.toContain('大きすぎ');
  });

  /** ⚠ RTF は囲みにできない ── **見送った理由を書く**(黙って落とさない)。 */
  it('⚠ リッチテキストは見送り、その理由も残す', () => {
    const r = run({ htmlFence: '```html\n<p>a</p>\n```' });
    expect(r.called, 'リッチテキストを解析している').not.toContain('rtf');
    expect(r.attempt.skipped.some((s) => s.kind === 'rtf')).toBe(true);
  });
});
