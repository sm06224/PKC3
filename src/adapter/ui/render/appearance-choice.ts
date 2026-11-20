/**
 * アクセントの色・字体の保存と適用(#1982 段 4)。意味論は `features/appearance-choice.ts`。
 * 作法は `text-scale.ts` と同じ: ① 壊れた保存は既定へ落ちる ② 当てるだけの `apply*` と、保存する `choose*` を分ける
 * ③ 既定を選んだら鍵ごと消す ④ 別のウィンドウの選択に付いていく。
 */
import {
  DEFAULT_ACCENT,
  DEFAULT_FONT,
  fontSpec,
  isAccentChoice,
  isFontChoice,
  type AccentChoice,
  type FontChoice,
} from '@features/appearance-choice';

export const ACCENT_STORAGE_KEY = 'pkc3.accent';
export const FONT_STORAGE_KEY = 'pkc3.font';
export const ACCENT_ATTR = 'data-pkc-accent';
export const FONT_ATTR = 'data-pkc-font';

function store(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readKey<T extends string>(key: string, ok: (v: string) => v is T, fallback: T): T {
  try {
    const v = store()?.getItem(key);
    return v !== null && v !== undefined && ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeKey(key: string, value: string, isDefault: boolean): void {
  try {
    if (isDefault) store()?.removeItem(key);
    else store()?.setItem(key, value);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}

export function initialAccent(): AccentChoice {
  return readKey(ACCENT_STORAGE_KEY, isAccentChoice, DEFAULT_ACCENT);
}

/** いま当たっているアクセント(DOM が正本)。 */
export function currentAccent(target: HTMLElement): AccentChoice {
  const v = target.getAttribute(ACCENT_ATTR);
  return v !== null && isAccentChoice(v) ? v : DEFAULT_ACCENT;
}

/** 当てる(保存しない)。`theme` は属性を外す = `tokens.css` の配色どおり。 */
export function applyAccent(target: HTMLElement, accent: AccentChoice): void {
  if (accent === DEFAULT_ACCENT) target.removeAttribute(ACCENT_ATTR);
  else target.setAttribute(ACCENT_ATTR, accent);
}

export function chooseAccent(target: HTMLElement, accent: AccentChoice): void {
  applyAccent(target, accent);
  writeKey(ACCENT_STORAGE_KEY, accent, accent === DEFAULT_ACCENT);
}

export function initialFont(): FontChoice {
  return readKey(FONT_STORAGE_KEY, isFontChoice, DEFAULT_FONT);
}

export function currentFont(target: HTMLElement): FontChoice {
  const v = target.getAttribute(FONT_ATTR);
  return v !== null && isFontChoice(v) ? v : DEFAULT_FONT;
}

/** 当てる(保存しない)。`--font` / `--font-mono` を `<html>` の style で上書きする。標準は上書きを外す。 */
export function applyFont(target: HTMLElement, font: FontChoice): void {
  if (font === DEFAULT_FONT) {
    target.removeAttribute(FONT_ATTR);
    target.style.removeProperty('--font');
    target.style.removeProperty('--font-mono');
    return;
  }
  const spec = fontSpec(font);
  target.setAttribute(FONT_ATTR, font);
  target.style.setProperty('--font', spec.ui);
  target.style.setProperty('--font-mono', spec.mono);
}

export function chooseFont(target: HTMLElement, font: FontChoice): void {
  applyFont(target, font);
  writeKey(FONT_STORAGE_KEY, font, font === DEFAULT_FONT);
}

/** 別のウィンドウで選んだ値を、開いたままの自分にも当てる。返り値で外す。 */
export function watchAppearanceChoiceFromOtherWindows(
  target: HTMLElement,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const onStorage = (ev: Event): void => {
    const key = (ev as StorageEvent).key;
    if (key === null || key === ACCENT_STORAGE_KEY) applyAccent(target, initialAccent());
    if (key === null || key === FONT_STORAGE_KEY) applyFont(target, initialFont());
  };
  win.addEventListener('storage', onStorage);
  return () => win.removeEventListener('storage', onStorage);
}
