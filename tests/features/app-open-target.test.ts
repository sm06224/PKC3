/**
 * 🔴 **アプリをどこに出すか**(#884 段①)。
 *
 * 守る主張:
 * 1. **既定はいまの挙動**(ブラウザのタブ)── 選んでいない人の手触りを変えない
 * 2. 🔴 **約束を引かない** ── `noopener,noreferrer` は、大きさを足しても残る
 * 3. 🔴 **タブのときは何も足さない** ── 足すと、選んでいないのに窓になる
 * 4. 綴りの検めが、表と 1 対 1
 */
import { describe, expect, it } from 'vitest';
import {
  APP_OPEN_TARGETS,
  APP_WINDOW_SIZE,
  DEFAULT_APP_OPEN_TARGET,
  appWindowFeatures,
  isAppOpenTarget,
} from '../../src/features/launcher/open-target';

describe('出し先の表(#884 段①)', () => {
  it('🔴 既定はブラウザのタブ(いまの挙動)', () => {
    expect(DEFAULT_APP_OPEN_TARGET).toBe('tab');
    // ⚠ **並びは「既定が先」**(`open-place` と同じ作法)
    expect(APP_OPEN_TARGETS[0]?.id).toBe(DEFAULT_APP_OPEN_TARGET);
  });

  it('綴りの検めが表と 1 対 1', () => {
    for (const t of APP_OPEN_TARGETS) expect(isAppOpenTarget(t.id)).toBe(true);
    expect(isAppOpenTarget('popup'), '表に無い綴りを通した').toBe(false);
    expect(isAppOpenTarget(''), '空を通した').toBe(false);
  });

  it('⚠ 画面に出す名前が、どれも空でない(押す前に何か分かる)', () => {
    for (const t of APP_OPEN_TARGETS) expect(t.label).not.toBe('');
  });
});

describe('窓の指定を組む(#884 段①)', () => {
  const PROMISE = 'noopener,noreferrer';

  it('🔴 タブのときは、渡された字を 1 バイトも変えない', () => {
    expect(appWindowFeatures('tab', PROMISE)).toBe(PROMISE);
    expect(appWindowFeatures('tab', ''), '空に何か足した').toBe('');
  });

  it('🔴 別の窓のときも、約束(noopener,noreferrer)は残る', () => {
    const f = appWindowFeatures('window', PROMISE);
    expect(f, 'noopener が消えた(約束を引いた)').toContain('noopener');
    expect(f, 'noreferrer が消えた(約束を引いた)').toContain('noreferrer');
  });

  it('🔴 別の窓のときだけ、大きさが付く', () => {
    const win = appWindowFeatures('window', PROMISE);
    expect(win).toContain(`width=${String(APP_WINDOW_SIZE.width)}`);
    expect(win).toContain(`height=${String(APP_WINDOW_SIZE.height)}`);
    expect(win, '窓だと名乗っていない(ブラウザがタブにする)').toContain('popup');
    // 🔴 対照群 ── タブの側には 1 つも付かない(付いたら、選んでいないのに窓になる)
    const tab = appWindowFeatures('tab', PROMISE);
    expect(tab).not.toContain('width=');
    expect(tab).not.toContain('popup');
  });

  it('⚠ 空の字に足すとき、先頭にコンマを付けない', () => {
    expect(appWindowFeatures('window', '').startsWith(','), '先頭がコンマ(綴りが壊れる)').toBe(
      false,
    );
    expect(appWindowFeatures('window', '')).toContain('popup');
  });
});
