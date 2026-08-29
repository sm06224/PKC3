/** @vitest-environment node */
/**
 * 🔴 **caret へ書き込む道具は、押しても焦点を奪わない**(user 報告 2026-08-28)。
 *
 * > 「インライン編集モードで雛形などの挿入ボタンを押しても何もおこらない /
 * >  …インライン編集位置からフォーカスが外れてしまっている?」
 *
 * live の 1 面では `mousedown` の既定が焦点を外し、`blur` が行を確定して
 * **`row-source` が DOM から消える**ので、`click` の時点で書き込む先が無い
 * = **無言 no-op**。だから `mousedown` の既定を止める必要がある。
 *
 * 🔴 **この検査の主張は「一覧が正しい」ではなく「一覧に漏れが無い」**である。
 * ⚠ 直す前は `act === 'format-text' || act === 'insert-date'` という**名指し**だった
 *   ので、同じ形の道具を足しても**誰も気づかない**(実際 3 つ漏れていた)。
 * 🔑 だから**実装から数え上げて突き合わせる** ── 「`formatTarget(root)` を呼ぶ
 *   handler」= 「caret へ書き込む道具」なので、その集合と `CARET_TOOLS` を
 *   **等値**で見る。⚠ 手で書いた一覧をもう 1 つ作ると、同じ漏れを 2 か所に書くだけになる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CARET_TOOLS } from '@adapter/ui/actions/binder';

const SRC = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8');

/**
 * `ACTIONS` の中で `formatTarget(root)` を呼ぶ handler の名前を集める。
 * ⚠ **コメントを落としてから見る** ── 注記の中にも綴りが出るので、原文のままだと
 *   「説明しか無い handler」を拾う(CLAUDE.md §1 で 5 回踏んだ型)。
 */
const caretWriters = (): Set<string> => {
  const code = SRC.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  /**
   * 🔴 **`ACTIONS` の中だけを見る**(2026-08-28、この検査自身が踏んだ)。
   *
   * ⚠ 1 稿目は最後の handler の区画を **file 末尾まで**伸ばしていたので、
   *   `ACTIONS` の外に在る `formatTarget(root)`(`onMousedown` の周り)を拾い、
   *   **`purge-trash` が caret へ書き込む**という嘘を出した。危うく
   *   `CARET_TOOLS` に無関係な物を足すところだった。
   * 🔑 CLAUDE.md §9「**開始と終了の両方を名指しする**」── 区画は必ず閉じる。
   */
  const open = code.indexOf('const ACTIONS: Record<string, ActionHandler> = {');
  if (open < 0) throw new Error('ACTIONS が見つからない ── この検査は何も見ていない');
  const close = code.indexOf('\n};', open);
  if (close < 0) throw new Error('ACTIONS の閉じが見つからない');
  const body = code.slice(open, close);
  const out = new Set<string>();
  // `  'name': (…) => {` … 次の handler の頭まで(最後は `ACTIONS` の閉じまで)
  const re = /^ {2}'([a-z0-9-]+)':\s*\(/gm;
  const heads = [...body.matchAll(re)];
  heads.forEach((m, i) => {
    const from = m.index ?? 0;
    const to = i + 1 < heads.length ? (heads[i + 1]!.index ?? body.length) : body.length;
    if (body.slice(from, to).includes('formatTarget(root)')) out.add(m[1]!);
  });
  return out;
};

describe('caret へ書き込む道具の集合(user 報告 2026-08-28)', () => {
  it('🔴 `formatTarget` を呼ぶ handler は、全部 CARET_TOOLS に居る', () => {
    const writers = caretWriters();
    // ⚠ **空振り防止** ── 数え方が壊れて 0 件になったら、この検査は何も見ていない
    expect(writers.size, '数え上げが壊れている(handler を 1 つも拾えていない)').toBeGreaterThan(
      3,
    );
    const missing = [...writers].filter((w) => !CARET_TOOLS.has(w));
    expect(
      missing,
      `caret へ書き込むのに焦点を守っていない道具がある(live の 1 面で無言 no-op になる): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('⚠ 逆向き ── CARET_TOOLS に「書き込まない物」を入れていない', () => {
    const writers = caretWriters();
    const extra = [...CARET_TOOLS].filter((t) => !writers.has(t));
    expect(
      extra,
      `caret へ書き込まないのに既定を止めている(押せない物を作りうる): ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('⚠ 名指しの `||` へ戻っていない(戻ると次の道具がまた漏れる)', () => {
    const code = SRC.split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(
      /act === 'format-text' \|\| act === 'insert-date'/.test(code),
      '名指しの判定が戻っている',
    ).toBe(false);
    expect(code, '集合で見ていない').toContain('CARET_TOOLS.has(act)');
  });
});
