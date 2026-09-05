/**
 * 🔴 **貼付でどの形を読むか**(user 指示 2026-08-25、3 通目)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * ⚠ ここが守るのは 3 つ:
 * ① **設定どおりの順で読む**(自動が当たらない回に、user が自分で直せる)
 * ② **要らない形は解析しない**(押した瞬間に止まらない)
 * ③ 🔴 **診断に中身を出さない**(貼ったものは私物で、画面の文字は履歴に残る)
 */
import { describe, expect, it } from 'vitest';
import {
  choosePaste,
  describePaste,
  DEFAULT_PASTE_SOURCE,
  isPasteSource,
  PASTE_SOURCES,
  type PasteSource,
} from '../../src/features/markdown/paste-source';

/** 呼ばれた口を数える(⚠ **遅延**であることの観測点)。 */
function run(
  source: PasteSource,
  have: {
    html?: string | null;
    htmlFence?: string | null;
    rtf?: string | null;
    permalink?: string | null;
  },
  sizes = { html: 100, rtf: 200, plain: 50 },
) {
  const called: string[] = [];
  const out = choosePaste({
    source,
    sizes,
    convert: {
      /** ⚠ ここでは試さない ── 段③ の検査は `paste-plain-table.test.ts` が持つ。 */
      plainTable: () => null,
      permalink: () => {
        called.push('permalink');
        return have.permalink ?? null;
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
  });
  return { ...out, called };
}

describe('設定の語彙', () => {
  it('既定は `auto`(設定を知らない人がいままでどおり)', () => {
    expect(DEFAULT_PASTE_SOURCE).toBe('auto');
    expect(PASTE_SOURCES[0]!.id).toBe('auto');
  });

  it('知らない値は受けない', () => {
    for (const s of PASTE_SOURCES) expect(isPasteSource(s.id)).toBe(true);
    expect(isPasteSource('rich')).toBe(false);
    expect(isPasteSource('')).toBe(false);
  });

  it('⚠ どの選択肢にも「なぜ選ぶか」が書いてある(名前だけでは選べない)', () => {
    for (const s of PASTE_SOURCES) expect(s.hint.length).toBeGreaterThan(8);
  });
});

describe('自動(既定)', () => {
  it('ウェブページの形が先、リッチテキストは控え', () => {
    const r = run('auto', { html: 'H', rtf: 'R' });
    expect(r.text).toBe('H');
    expect(r.attempt.used).toBe('html');
    // 🔑 **RTF は解析していない**(要らない形に時間を使わない)
    expect(r.called).not.toContain('rtf');
  });

  it('ウェブページの形が空振りしたらリッチテキストへ回る', () => {
    const r = run('auto', { html: null, rtf: 'R' });
    expect(r.text).toBe('R');
    expect(r.attempt.used).toBe('rtf');
    expect(r.attempt.skipped).toContainEqual({
      kind: 'html',
      why: '変換しても得るものがありませんでした',
    });
  });

  it('どちらも駄目なら介入しない(既定の貼付に委ねる)', () => {
    const r = run('auto', { html: null, rtf: null });
    expect(r.text).toBeNull();
    expect(r.attempt.used).toBe('plain');
  });

  it('ノートへのリンクはいちばん先(外部リンクの形にしない)', () => {
    const r = run('auto', { permalink: 'P', html: 'H' });
    expect(r.text).toBe('P');
    expect(r.called).not.toContain('html');
  });

  it('届いていない形は「届いていません」と記録する', () => {
    const r = run('auto', { html: null }, { html: 0, rtf: 0, plain: 10 });
    expect(r.attempt.skipped).toEqual([
      { kind: 'html', why: '届いていません' },
      { kind: 'rtf', why: '届いていません' },
    ]);
    expect(r.called).toEqual(['permalink']); // 🔑 1 つも解析していない
  });
});

describe('ウェブページの形だけ', () => {
  it('🔴 リッチテキストを読まない(届いていても)', () => {
    const r = run('html', { html: null, rtf: 'R' });
    expect(r.text, 'リッチテキストを読んでいる').toBeNull();
    expect(r.called, 'リッチテキストを解析している').not.toContain('rtf');
  });

  it('⚠ 読まなかった理由を残す(黙って落とさない)', () => {
    const r = run('html', { html: 'H', rtf: 'R' });
    expect(r.attempt.skipped).toContainEqual({ kind: 'rtf', why: '設定で読まない形です' });
  });
});

describe('リッチテキストを優先', () => {
  it('🔴 ウェブページの形より先に読む', () => {
    const r = run('rtf', { html: 'H', rtf: 'R' });
    expect(r.text).toBe('R');
    expect(r.attempt.used).toBe('rtf');
    expect(r.called, 'ウェブページの形を解析している').not.toContain('html');
  });

  it('リッチテキストが空振りしたらウェブページの形へ回る(切り捨てない)', () => {
    const r = run('rtf', { html: 'H', rtf: null });
    expect(r.text).toBe('H');
    expect(r.attempt.used).toBe('html');
  });
});

describe('変換しない', () => {
  it('🔴 何も解析しない', () => {
    const r = run('plain', { html: 'H', rtf: 'R', permalink: 'P' });
    expect(r.text).toBeNull();
    expect(r.called, '「変換しない」なのに解析している').toEqual([]);
  });

  it('🔴 ノートへのリンクも書き換えない(設定の字が嘘にならない)', () => {
    const r = run('plain', { permalink: 'P' });
    expect(r.text).toBeNull();
    expect(r.attempt.used).toBe('plain');
  });
});

describe('診断の 1 行', () => {
  const attempt = (over: Partial<Parameters<typeof describePaste>[0]> = {}) =>
    describePaste({
      source: 'auto',
      sizes: { html: 1234, rtf: 5678, plain: 90 },
      used: 'html',
      skipped: [],
      ...over,
    });

  it('何が届いて、どれを使ったかが分かる', () => {
    const s = attempt();
    expect(s).toContain('1,234');
    expect(s).toContain('5,678');
    expect(s).toContain('ウェブページの形を使いました');
  });

  it('🔴 中身を 1 文字も出さない(貼ったものは私物で、画面の文字は履歴に残る)', () => {
    const s = describePaste({
      source: 'auto',
      sizes: { html: 3, rtf: 0, plain: 3 },
      used: 'html',
      skipped: [],
    });
    // 🔑 出るのは**大きさと判断**だけ ── 数字と決まった語しか出ない
    expect(s).not.toMatch(/[<>{}\\]/);
  });

  it('見送った理由が付く(なぜ使われなかったかが分かる)', () => {
    const s = attempt({ used: 'rtf', skipped: [{ kind: 'html', why: '設定で読まない形です' }] });
    expect(s).toContain('ウェブページの形は設定で読まない形です');
  });

  it('⚠ 既定でないときは設定の名前を出す(何が効いているか分かる)', () => {
    expect(attempt({ source: 'rtf' })).toContain('リッチテキストを優先');
    expect(attempt({ source: 'auto' }), '既定まで書くと毎回うるさい').not.toContain('設定:');
  });

  it('何も届いていない回も、そう言う', () => {
    expect(attempt({ sizes: { html: 0, rtf: 0, plain: 0 }, used: 'plain' })).toContain(
      '何も届いていません',
    );
  });
});

/**
 * 🔴 **大きさで断らない**(#492。user 指示 2026-08-27
 * 「**貼付やコードブロックフェンスでアセット埋め込みする際の上限バイトは不要。
 * 現実問題、画像埋め込みのHTMLとか増えてるし、できないのは困る**」)。
 *
 * ⚠ ここは 2026-08-27 まで**逆のことを守っていた**(#487「大きすぎて読まなかった、
 *   と書く」)── 上限を超えた貼付は変換器を**呼ばずに**理由を出す、という検査だった。
 *   user の指示はその手前で、「**そもそも断るな**」である。
 *
 * ⚠ **向きを裏返したので、作法も裏返している**(#250 の教訓)── 「呼ばない」を
 *   守るときは広く見てよかったが、「**呼ぶ**」を守るいまは
 *   **呼んだ証拠**(`called`)と**使った証拠**(`used`)の両方が要る。
 */
describe('🔴 大きさで断らない (#492)', () => {
  /** ⚠ 旧上限(いまは存在しない)。**これを超える値で試すこと**が空振り防止である。 */
  const OLD_HTML_CAP = 1024 * 1024;
  const OLD_RTF_CAP = 4 * 1024 * 1024;

  /** その形の見送りの理由。 */
  const why = (out: ReturnType<typeof run>, kind: string): string | undefined =>
    out.attempt.skipped.find((s) => s.kind === kind)?.why;
  /**
   * 見送りの理由(無ければ空文字)。
   * ⚠ **`undefined` のまま `not.toContain` へ渡さない** ── 見送っていない回は
   *   `undefined` になり、assert 自体が例外で落ちる(「断っていない」のが
   *   正しいのに赤くなる = 検査が主張を裏切る)。
   */
  const whyText = (out: ReturnType<typeof run>, kind: string): string => why(out, kind) ?? '';

  it('🔴 旧上限を大きく超える HTML でも、変換器を呼んで使う', () => {
    const out = run('auto', { html: '# 変換できた' }, {
      html: OLD_HTML_CAP * 8,
      rtf: 0,
      plain: 5,
    });
    expect(out.called, '大きいだけで変換器を呼ばなかった').toContain('html');
    expect(out.attempt.used, '呼んだのに結果を使っていない').toBe('html');
    expect(whyText(out, 'html'), '大きさを理由に断っている').not.toContain('大きすぎ');
  });

  it('🔴 旧上限を大きく超える RTF でも、変換器を呼んで使う', () => {
    const out = run('rtf', { rtf: '# 変換できた' }, {
      html: 0,
      rtf: OLD_RTF_CAP * 4,
      plain: 5,
    });
    expect(out.called, '大きいだけで変換器を呼ばなかった').toContain('rtf');
    expect(out.attempt.used, '呼んだのに結果を使っていない').toBe('rtf');
    expect(whyText(out, 'rtf'), '大きさを理由に断っている').not.toContain('大きすぎ');
  });

  it('🔴 囲みも、大きさで断らない', () => {
    const out = run('html-fence', { htmlFence: '```html\nx\n```' }, {
      html: OLD_HTML_CAP * 8,
      rtf: 0,
      plain: 5,
    });
    expect(out.called, '大きいだけで囲みを組まなかった').toContain('htmlFence');
    expect(out.attempt.used).toBe('html-fence');
    expect(whyText(out, 'html'), '大きさを理由に断っている').not.toContain('大きすぎ');
  });

  /**
   * ⚠ **対照群** ── 断る理由が**全部**消えたわけではない。中身が空なら断る。
   * 🔑 これが無いと、「理由を出す仕組みごと壊した」変異が生き延びる。
   */
  it('⚠ 変換できなかったときは、これまでどおり理由を出す', () => {
    const out = run('auto', { html: null }, { html: 100, rtf: 0, plain: 5 });
    expect(why(out, 'html')).toContain('得るもの');
    expect(out.called, '変換を試していない(前提が崩れた)').toContain('html');
  });

  it('⚠ 囲みで中身が空なら、これまでどおり「空」と言う', () => {
    const empty = run('html-fence', { htmlFence: null }, { html: 100, rtf: 0, plain: 5 });
    expect(why(empty, 'html')).toContain('空');
    expect(empty.called).toContain('htmlFence');
  });
});
