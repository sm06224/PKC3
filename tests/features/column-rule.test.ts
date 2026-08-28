/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COLUMN_RULES,
  columnRuleSpec,
  DEFAULT_COLUMN_RULE,
  isColumnRule,
} from '../../src/features/column-rule';
import {
  applyColumnRule,
  COLUMN_RULE_ATTR,
  COLUMN_RULE_VAR,
  currentColumnRule,
} from '../../src/adapter/ui/render/column-rule';

describe('段の境界線(#525)', () => {
  /**
   * 🔴 **既定は「いまと 1 バイトも同じ」**(#504 と同じ作法)。
   *
   * ⚠ これが崩れると、**選んでいない user の見え方が勝手に変わる** ──
   *   user 指示 2026-08-28「正直変更はユーザーに委ねて欲しい」に正面から反する。
   * 🔑 だから **CSS の予備の値と、既定の表の値が一致すること**を突き合わせる
   *   (片方だけ動いたら落ちる ── §7)。
   */
  it('🔴 既定は CSS の予備の値そのまま(選ばなければ見え方が変わらない)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    const m = /column-rule:\s*var\(--pkc-col-rule,\s*([^)]*\([^)]*\)[^)]*|[^)]*)\)/.exec(css);
    expect(m, 'CSS が変数で受けていない').not.toBeNull();
    expect(
      m![1]!.trim(),
      '予備の値と既定の表が食い違う(選ばない user の見え方が変わる)',
    ).toBe(columnRuleSpec(DEFAULT_COLUMN_RULE).rule);
  });

  it('🔴 既定は 3 択のうち「細い」(現行)', () => {
    expect(DEFAULT_COLUMN_RULE).toBe('thin');
    expect(COLUMN_RULES.map((c) => c.id)).toEqual(['thin', 'clear', 'none']);
  });

  /**
   * 🔴 **「はっきり」は本当に濃い**(#525 の目的そのもの)。
   *
   * ⚠ 実測すると既定は **コントラスト 1.52 : 1**(文字以外の下限 3 : 1)だった。
   * 🔑 ここでは**色を数えない**(`color-mix` は happy-dom で解決できない)──
   *   見るのは「**前景色から作っている**」ことだけで、実際の濃さは
   *   `tests/smoke/read-columns.smoke.spec.ts` が画素で測る。
   * ⚠ **`--border` を使っていないこと**まで見る ── あれは 90 か所で共有されており、
   *   そこを濃くすると画面全体の線が太って見える。
   */
  it('🔴 「はっきり」は前景色から作る(共有の --border を濃くしない)', () => {
    const clear = columnRuleSpec('clear').rule;
    expect(clear, '前景色から作っていない').toContain('--fg');
    expect(clear, '共有の --border を使っている(画面全体の線が変わる)').not.toContain('--border');
  });

  it('⚠ 「線なし」は幅 0 ではなく none(すき間の計算をずらさない)', () => {
    expect(columnRuleSpec('none').rule).toBe('none');
  });

  it('知らない id は既定へ落ちる(呼び側で分岐させない)', () => {
    expect(isColumnRule('bogus')).toBe(false);
    expect(columnRuleSpec('bogus' as never).id).toBe(DEFAULT_COLUMN_RULE);
  });

  /**
   * ⚠ **DOM が正本**(保存を読み直さない)── 保存できない環境では
   *   「この session だけ効いている」値が正しい。
   */
  it('🔴 当てると DOM から読み戻せる(印と変数の両方)', () => {
    const el = document.createElement('div');
    applyColumnRule(el, 'clear');
    expect(el.getAttribute(COLUMN_RULE_ATTR)).toBe('clear');
    expect(el.style.getPropertyValue(COLUMN_RULE_VAR)).toBe(columnRuleSpec('clear').rule);
    expect(currentColumnRule(el)).toBe('clear');
    // 何も当たっていない要素は既定
    expect(currentColumnRule(document.createElement('div'))).toBe(DEFAULT_COLUMN_RULE);
  });
});
