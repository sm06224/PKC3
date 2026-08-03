/**
 * 配色(P7b 段⑨c)。
 *
 * > user 指示 2026-08-03「**テーマカラーは、最初はライトとダークのみにしましょう**」
 *
 * 🔑 **2 つだけ**。増やすのは後でよい ── 「最初は」と言われている。
 *
 * ⚠ **flag ではない**。これは user の好みであって開発用の切替ではないので、
 * flag 機構(15 枠、`settings` と分離する規約)には載せない。保存先は
 * `localStorage` の 1 キーだけにして、**アプリのデータには混ぜない**
 * (container に入れると export / import / 同期の意味論に巻き込まれる)。
 *
 * ⚠ 保存が読めない環境(Safari のプライベート等で `localStorage` が投げる)でも
 * **アプリは動く** ── 既定に落ちるだけ。
 */

export type Theme = 'light' | 'dark';

/** ⚠ 1 キーだけ。増やすなら設定機構を建ててからにする。 */
const KEY = 'pkc3.theme';

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

function write(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 保存できないだけ。この session では効いている
  }
}

/**
 * 最初に使う配色 ── **保存されていれば それ、無ければ OS に従う**。
 * ⚠ OS を見ないと、暗い部屋の人にいきなり白を出すことになる。
 */
export function initialTheme(prefersDark?: boolean): Theme {
  const stored = readStored();
  if (stored) return stored;
  const dark =
    prefersDark ??
    (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? 'dark' : 'light';
}

/** 逆の配色。 */
export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/**
 * 適用する。⚠ **属性 1 つで切り替える** ── CSS 側は
 * `:root[data-pkc-theme='light']` を上書きに使う(class にすると minify や
 * 別 renderer の書き換えで静かに外れる、というこのリポジトリの規約に従う)。
 */
export function applyTheme(target: HTMLElement, theme: Theme): void {
  target.setAttribute('data-pkc-theme', theme);
  write(theme);
}
