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
