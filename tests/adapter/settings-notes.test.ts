/** @vitest-environment happy-dom */
/**
 * 🔴 **設定の説明は 1 行、詳しくは hover とマニュアルへ**
 * (#1017 §6.1 規則 3、#1038 段J で `settings.ts` 直下の全 24 段落へ適用)。
 *
 * ## なぜ character cap で見るか
 *
 * happy-dom は CSS を計算しないので「実際に折り返しているか」は unit から見えない
 * (CLAUDE.md §4「観測点が放っておいても変わるなら…」の逆 ── ここは逆に、
 * 見えないものを見ようとしない)。だから ①ここは**速い代理指標**(文字数の上限)で
 * 押さえ、②**実際に折り返さないか**は実ブラウザ(`tests/smoke/system-toc.smoke.spec.ts`)
 * の visual parity で見る、の 2 段構成にする。
 *
 * ## 上限の出どころ(実測。2026-09-26)
 *
 * 実ビルドを 1280px の窓で開き、「システム」の note のうち最も狭い `dd` の幅は
 * **642px**、その `font-size: 11px` での全角 1 文字の描画幅(canvas
 * `measureText('あ')`)は **11px**。642 / 11 ≈ 58 文字 ── 半角が混じるぶん実際は
 * もっと入る。ここでは**安全側**に切って **55 文字**を上限にする。
 * ⚠ 上限を上げるだけの「通したいから緩める」はしない(CLAUDE.md「案が門を通らない
 * ときは、まず門ではなく案を疑う」)── 緩めるなら実測し直して justify を書き直す。
 */
import { describe, expect, it } from 'vitest';
import { SettingsRenderer, PERSIST_TEXT } from '@adapter/ui/render/settings';
import { initialState } from '@adapter/state/app-state';
import type { AppState } from '@adapter/state/app-state';

/** 実測(2026-09-26、1280px 窓・font-size 11px)から出した安全側の上限。 */
const CHAR_CAP = 55;

/**
 * 🔴 **不可逆・データが消える警告はここへ流さない**(hover へ逃がさず、1 行では
 * 収まらなくても visible の note に残す ── ruling 6「不可逆は必ず言う」)。
 * ⚠ `data-pkc-region` で識別する(この note には固有の field 名が無い)。
 * この 1 件だけが既知の例外(等値 pin ── 増やすなら実測して justify を書く)。
 */
const KNOWN_MULTILINE_REGIONS: readonly string[] = ['settings-persist'];

function render(state: AppState = initialState): HTMLElement {
  const host = document.createElement('div');
  new SettingsRenderer(host).render(state);
  return host;
}

/** `settings.ts` が直接持つ note だけを見る(keymap / office 一式の note は別モジュールの持ち物)。 */
function ownNotes(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-pkc-field="settings-note"]')].filter(
    (el) =>
      el.closest('[data-pkc-region="settings-keymap"]') === null &&
      el.closest('[data-pkc-region="settings-office"]') === null,
  );
}

describe('設定の説明は 1 行(#1017 §6.1 規則 3、#1038 段J)', () => {
  it('🔴 空振り防止: settings.ts 直下の note はちょうど 24 段落(doc の数え直しと一致)', () => {
    const notes = ownNotes(render());
    expect(notes).toHaveLength(24);
  });

  it('① 既知の例外(このアプリのデータ)以外は、実測の上限(55 文字)に収まる', () => {
    const host = render();
    const notes = ownNotes(host);
    let checked = 0;
    for (const note of notes) {
      if (KNOWN_MULTILINE_REGIONS.some((r) => note.closest(`[data-pkc-region="${r}"]`))) continue;
      checked += 1;
      expect(
        (note.textContent ?? '').length,
        `1 行に収まらない(${(note.textContent ?? '').slice(0, 20)}…)`,
      ).toBeLessThanOrEqual(CHAR_CAP);
    }
    // ⚠ 空振り防止 ── 例外を除いた行が 1 つも無ければ、この検査は何も見ていない
    expect(checked, '例外だけで全部除かれた(空振り)').toBeGreaterThan(15);
  });

  it('② 既知の例外(このアプリのデータ)は、不可逆・データが消える警告を落とさない', () => {
    for (const state of (['denied', 'unsupported'] as const)) {
      const host = render({ ...initialState, persistState: state });
      const note = host
        .querySelector('[data-pkc-region="settings-persist"]')!
        .querySelector('[data-pkc-field="settings-note"]')!;
      // ⚠ 等値 pin ── PERSIST_TEXT の警告を 1 バイトも削らない(ruling 6)
      expect(note.textContent).toBe(PERSIST_TEXT[state]);
      expect((note.textContent ?? '').length).toBeGreaterThan(CHAR_CAP);
    }
  });

  it('🔑 検算: 例外リストは実在する region を指している(架空の例外を書かない)', () => {
    const host = render({ ...initialState, persistState: 'denied' });
    for (const region of KNOWN_MULTILINE_REGIONS) {
      expect(
        host.querySelector(`[data-pkc-region="${region}"]`),
        `例外に挙げた region "${region}" が画面に無い`,
      ).not.toBeNull();
    }
  });
});
