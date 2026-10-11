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
  { id: 'terminal', label: 'ターミナル(端末風)', dark: true },
  { id: 'retro', label: 'レトロ(茶とオレンジ)', dark: true },
] as const;

export type Theme = (typeof THEMES)[number]['id'];

const IDS: readonly string[] = THEMES.map((t) => t.id);

export function isTheme(v: string): v is Theme {
  return IDS.includes(v);
}

/**
 * 「OS に合わせる」の保存値(#1386)。⚠ **配色ではない**(`tokens.css` に
 * `[data-pkc-theme='auto']` は無い)── 選ぶと、その時々の OS の明暗に応じて
 * 既定の 2 つ(`light` / `dark`)のどちらかを `<html>` に立てる。
 * だから `THEMES`(= 実在する配色の一覧)には入れない。
 */
export const THEME_AUTO = 'auto';

/** 選べるもの = 配色 + 「OS に合わせる」。 */
export type ThemeChoice = Theme | typeof THEME_AUTO;

export const THEME_AUTO_LABEL = 'OS に合わせる';

export function isThemeChoice(v: string): v is ThemeChoice {
  return v === THEME_AUTO || isTheme(v);
}

/** 選び方と OS の明暗から、実際に当てる配色を決める(純関数)。 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice !== THEME_AUTO) return choice;
  return prefersDark ? 'dark' : 'light';
}

/**
 * ⚠ **端末ごとの保存は `pkc3.*` を 1 鍵ずつ**(2026-08-08 に書き換えた)。
 *
 * ここには長く「1 キーだけ。増やすなら設定機構を建ててからにする」と書いてあったが、
 * P11 で**設定機構は建った** ── いまは 6 鍵ある(`pkc3.theme` /
 * `pkc3.external-images` / `pkc3.flags` / `pkc3.notices.seen` / `pkc3.notices.off` /
 * `pkc3.page-format`)。
 *
 * 🔑 増やすときは `flag-store.ts` / `notice-store.ts` と**同じ作法**で:
 * ① 壊れていても**既定へ落ちる**(読めない値で起動不能にしない)
 * ② **export に混ぜない**(書き出した HTML を渡した相手の設定を書き換えない)
 * ③ **user が戻せる**(消す導線か、既定へ戻す導線を必ず置く)
 *
 * 🔑 **export している**のは、焼いたマニュアル(`build/manual-page-plugin.ts` →
 *   `features/help/manual-page.ts` の inline script)が**同じ鍵**を読むため ──
 *   綴りを写すと、鍵を変えた日にマニュアルの窓だけ配色が戻る。
 */
export const THEME_STORAGE_KEY = 'pkc3.theme';

function readStored(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v !== null && isThemeChoice(v) ? v : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/**
 * いまの選び方。⚠ **何も保存されていなければ「OS に合わせる」**(#1386)──
 * 従来も「無ければ起動時に OS に従う」だったので、変わるのは**起動後に OS が切り替わったら
 * 追従する**ことだけである(選んでいない人の見え方は、起動時点では 1 バイトも変わらない)。
 */
export function readThemeChoice(): ThemeChoice {
  return readStored() ?? THEME_AUTO;
}

function osPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function write(theme: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 保存できないだけ。この session では効いている
  }
}

/**
 * 最初に使う配色 ── **保存されていれば それ、無ければ OS に従う**。
 * ⚠ OS を見ないと、暗い部屋の人にいきなり白を出すことになる。
 */
export function initialTheme(prefersDark?: boolean): Theme {
  return resolveTheme(readThemeChoice(), prefersDark ?? osPrefersDark());
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
  syncThemeColor(target);
}

/**
 * 🔴 **ブラウザの枠の色を、いまの配色に合わせる**(#718)。
 *
 * ⚠ `index.html` の `<meta name="theme-color">` は **1 つの固定値**だった ──
 *   ライト系の配色を選んでも、Android の Chrome / iOS の PWA では帯だけが暗いまま
 *   残る(user から見ると**アプリの上端だけ色が違う**)。
 * 🔑 **固定値を持たない** ── `tokens.css` の `--bg` を読んで写す。色の正本は
 *   `tokens.css` 1 か所である、という規約をここでも破らない
 *   (ここに 9 色の表を持つと、配色を足した日に**ここだけ古くなる**)。
 * ⚠ 読むのは**属性を立てた後**(上の 1 行)── 前だと 1 つ前の配色の色を写す。
 * ⚠ `<meta>` が無い document(test の素の器 / 焼いた HTML)では**何もしない** ──
 *   器を新しく作らない(作ると、書き出した HTML に身に覚えのない `<meta>` が増える)。
 */
function syncThemeColor(target: HTMLElement): void {
  const doc = target.ownerDocument;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta === null) return;
  const bg = doc.defaultView?.getComputedStyle(target).getPropertyValue('--bg').trim() ?? '';
  if (bg !== '') meta.content = bg;
}

/** OS の明暗の変化を聞いている間の「やめる」(聞いていなければ null)。 */
let stopFollowing: (() => void) | null = null;

/**
 * 🔑 **「OS に合わせる」の間だけ OS の切り替えを聞く**(#1386)。
 * ⚠ 呼ぶたびに前の listener を外してから付け直す ── 重ねて付くと、別の配色へ
 *   替えた後も古い listener が上書きし続ける(外し忘れは画面で見分けがつかない)。
 * ⚠ 聞くのは選び方が `auto` のときだけ。ほかの配色を選んだら外す。
 */
export function syncThemeFollow(target: HTMLElement): void {
  stopFollowing?.();
  stopFollowing = null;
  if (readThemeChoice() !== THEME_AUTO) return;
  if (typeof matchMedia !== 'function') return;
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const onChange = (e: { matches: boolean }): void => {
    applyTheme(target, resolveTheme(THEME_AUTO, e.matches));
  };
  mql.addEventListener('change', onChange);
  stopFollowing = () => mql.removeEventListener('change', onChange);
}

/**
 * user が選んだ ── 適用して**保存する**。
 * ⚠ 起動時にはこれを呼ばない(呼ぶと M-7 が再発する)。
 * `auto` なら OS の今の明暗で当て、以後の切り替えにも付いていく。
 */
export function chooseTheme(target: HTMLElement, choice: ThemeChoice): void {
  write(choice);
  applyTheme(target, resolveTheme(choice, osPrefersDark()));
  syncThemeFollow(target);
}
