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

/**
 * 選べる配色。⚠ **id は `tokens.css` の `[data-pkc-theme='…']` と 1 対 1**。
 * 片方だけ増やしても壊れないので、`tests/adapter/theme-tokens.test.ts` が
 * 両方を突き合わせる(CSS に無い id を出さない / CSS にあるのに選べない、を落とす)。
 * ⚠ かつてここは `theme-contrast.test.ts` を指していたが、その file は無い
 *   (2026-08-06 に修正 ── 壊れた導線を置かない)。
 */
export const THEMES = [
  { id: 'light', label: 'ライト', dark: false },
  { id: 'dark', label: 'ダーク', dark: true },
  { id: 'github', label: 'GitHub', dark: false },
  { id: 'github-dark', label: 'GitHub ダーク', dark: true },
  { id: 'solarized', label: 'Solarized', dark: false },
  { id: 'solarized-dark', label: 'Solarized ダーク', dark: true },
  { id: 'dracula', label: 'Dracula', dark: true },
  { id: 'nord', label: 'Nord', dark: true },
  { id: 'terminal', label: '端末', dark: true },
] as const;

export type Theme = (typeof THEMES)[number]['id'];

const IDS: readonly string[] = THEMES.map((t) => t.id);

export function isTheme(v: string): v is Theme {
  return IDS.includes(v);
}

/** ⚠ 1 キーだけ。増やすなら設定機構を建ててからにする。 */
const KEY = 'pkc3.theme';

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v !== null && isTheme(v) ? v : null;
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

/** 明暗の逆側(既定の 2 つの間を往復する)。 */
export function otherTheme(theme: Theme): Theme {
  const cur = THEMES.find((t) => t.id === theme);
  return cur?.dark === true ? 'light' : 'dark';
}

/**
 * 適用する。⚠ **属性 1 つで切り替える** ── CSS 側は
 * `:root[data-pkc-theme='light']` を上書きに使う(class にすると minify や
 * 別 renderer の書き換えで静かに外れる、というこのリポジトリの規約に従う)。
 *
 * 🔴 **保存しない**(P7b review M-7)。初版は適用のたびに書いていたので、
 * 起動時の `applyTheme(…, initialTheme())` が **OS の設定をそのまま保存**し、
 * 「一度も選んでいないのに初回起動時の OS 設定で固定される」状態になっていた
 * (実測: OS=dark で初回起動 → `stored:'dark'` → OS を light に戻しても dark のまま)。
 * 保存は **user が選んだとき**だけ ── `chooseTheme` が持つ。
 */
export function applyTheme(target: HTMLElement, theme: Theme): void {
  target.setAttribute('data-pkc-theme', theme);
}

/**
 * user が選んだ ── 適用して**保存する**。
 * ⚠ 起動時にはこれを呼ばない(呼ぶと M-7 が再発する)。
 */
export function chooseTheme(target: HTMLElement, theme: Theme): void {
  applyTheme(target, theme);
  write(theme);
}
