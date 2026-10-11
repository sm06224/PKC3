/** @vitest-environment happy-dom */
/**
 * P7b review M-7 / L-1: 配色。
 *
 * 🔴 初版は**適用のたびに保存**していたので、起動時の
 * `applyTheme(…, initialTheme())` が **OS の設定をそのまま保存**し、
 * 「一度も選んでいないのに初回起動時の OS 設定で固定される」状態だった。
 * 実測: OS=dark で初回起動 → `stored:'dark'` → OS を light に戻しても dark のまま。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  THEMES,
  applyTheme,
  chooseTheme,
  initialTheme,
  isTheme,
  isThemeChoice,
  otherTheme,
  readThemeChoice,
  resolveTheme,
  syncThemeFollow,
} from '../../src/adapter/ui/render/theme';

const KEY = 'pkc3.theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-pkc-theme');
});

/** `matchMedia('(prefers-color-scheme: dark)')` の偽物。listener の出入りを数える。 */
function fakeMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { dark: initialDark };
  const mql = {
    get matches() {
      return state.dark;
    },
    addEventListener: (type: string, fn: (e: { matches: boolean }) => void) => {
      if (type === 'change') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: { matches: boolean }) => void) => {
      if (type === 'change') listeners.delete(fn);
    },
  };
  vi.stubGlobal('matchMedia', () => mql);
  return {
    listeners,
    setOs(dark: boolean) {
      state.dark = dark;
      for (const fn of [...listeners]) fn({ matches: dark });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('🔴 「OS に合わせる」(#1386)', () => {
  const html = (): string | null => document.documentElement.getAttribute('data-pkc-theme');

  it('resolveTheme: auto は OS の明暗で light / dark、配色を選んでいれば OS を見ない', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('nord', false)).toBe('nord');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('auto は配色ではない(THEMES に入れない / 保存値としては受ける)', () => {
    expect(isTheme('auto')).toBe(false);
    expect(THEMES.some((t) => (t.id as string) === 'auto')).toBe(false);
    expect(isThemeChoice('auto')).toBe(true);
    expect(isThemeChoice('nord')).toBe(true);
    expect(isThemeChoice('bogus')).toBe(false);
  });

  it('何も保存していなければ auto、壊れた値も auto、保存した配色はそのまま', () => {
    expect(readThemeChoice()).toBe('auto');
    localStorage.setItem(KEY, 'bogus');
    expect(readThemeChoice()).toBe('auto');
    localStorage.setItem(KEY, 'nord');
    expect(readThemeChoice()).toBe('nord');
  });

  it('auto を選ぶと保存され、OS の今の明暗で当たり、起動時の答えも OS に従う', () => {
    fakeMatchMedia(true);
    chooseTheme(document.documentElement, 'auto');
    expect(localStorage.getItem(KEY)).toBe('auto');
    expect(html()).toBe('dark');
    expect(initialTheme(false)).toBe('light');
    expect(initialTheme(true)).toBe('dark');
  });

  it('🔴 auto の間は OS の切り替えに付いていく(再読み込み無し)', () => {
    const os = fakeMatchMedia(false);
    chooseTheme(document.documentElement, 'auto');
    expect(html()).toBe('light');
    os.setOs(true);
    expect(html()).toBe('dark');
    os.setOs(false);
    expect(html()).toBe('light');
    // 保存は変わらない(OS の変化を「選んだ」ことにしない)
    expect(localStorage.getItem(KEY)).toBe('auto');
  });

  it('🔴 別の配色を選ぶと listener を外し、OS が変わっても動かない', () => {
    const os = fakeMatchMedia(false);
    chooseTheme(document.documentElement, 'auto');
    expect(os.listeners.size).toBe(1);
    chooseTheme(document.documentElement, 'dracula');
    expect(os.listeners.size).toBe(0);
    os.setOs(true);
    expect(html()).toBe('dracula');
  });

  it('auto を繰り返し選んでも listener は 1 つしか増えない / 起動時の syncThemeFollow も同じ', () => {
    const os = fakeMatchMedia(false);
    chooseTheme(document.documentElement, 'auto');
    chooseTheme(document.documentElement, 'auto');
    syncThemeFollow(document.documentElement);
    expect(os.listeners.size).toBe(1);
  });

  it('何も保存していない起動(= auto)でも OS に付いていく / 配色を保存していれば聞かない', () => {
    const os = fakeMatchMedia(false);
    syncThemeFollow(document.documentElement);
    expect(os.listeners.size).toBe(1);
    os.setOs(true);
    expect(html()).toBe('dark');
    localStorage.setItem(KEY, 'nord');
    syncThemeFollow(document.documentElement);
    expect(os.listeners.size).toBe(0);
  });
});

describe('配色', () => {
  it('🔴 起動時の適用は **保存しない**', () => {
    applyTheme(document.documentElement, 'dark');
    expect(document.documentElement.getAttribute('data-pkc-theme')).toBe('dark');
    // ⚠ ここが保存されると、次の起動で OS 設定が無視される
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('🔴 user が選んだときだけ保存する', () => {
    chooseTheme(document.documentElement, 'light');
    expect(document.documentElement.getAttribute('data-pkc-theme')).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
  });

  it('選んでいなければ OS に従い、選んだ後はそちらが優先される', () => {
    expect(initialTheme(true)).toBe('dark');
    expect(initialTheme(false)).toBe('light');
    chooseTheme(document.documentElement, 'dark');
    expect(initialTheme(false)).toBe('dark'); // 選んだほうが勝つ
  });

  it('逆の配色', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });
});

/**
 * 🔴 **ブラウザの枠の色(`<meta name="theme-color">`)を配色に合わせる**(#718)。
 *
 * ⚠ 直す前は `index.html` の**固定値 1 つ**(`#0f172a`)だった ── ライト系を選んでも
 *   Android の Chrome / iOS の PWA では上端の帯だけが暗いまま残る。
 * 🔑 期待値は **`tokens.css` を読んで作る**(実装と同じ `getComputedStyle` で作らない)──
 *   同じ綴りで期待値を組むと、実装が間違える形では期待値も同じように間違える
 *   (CLAUDE.md §1「期待値は別の観測から作る」)。
 */
describe('🔴 枠の色を配色に合わせる(#718)', () => {
  // ⚠ happy-dom の `import.meta.url` は file: ではない ── repo からの相対で読む
  const css = readFileSync('src/styles/tokens.css', 'utf8');

  /** `tokens.css` に**字として**書いてある、その配色の地の色。 */
  const declaredBg = (theme: string): string => {
    const needle =
      theme === 'light'
        ? ":root,\n:root[data-pkc-theme='light'] {"
        : `:root[data-pkc-theme='${theme}'] {`;
    const at = css.indexOf(needle);
    expect(at, `${theme} のブロックが tokens.css に無い`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', at);
    const body = css.slice(open, css.indexOf('}', open));
    return /^\s*--bg:\s*([^;]+);/m.exec(body)?.[1]?.trim() ?? '';
  };

  const meta = (): HTMLMetaElement => {
    let m = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (m === null) {
      m = document.createElement('meta');
      m.name = 'theme-color';
      m.content = '#0f172a'; // index.html が焼いている初期値
      document.head.append(m);
    }
    return m;
  };

  beforeEach(() => {
    document.head.textContent = '';
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  });

  it('🔴 10 配色すべてで、枠の色が tokens.css の地の色と一致する', () => {
    const m = meta();
    // 空振り防止 ── 10 件そろって空文字だと「全部一致」で通ってしまう
    const seen = new Set<string>();
    for (const t of THEMES) {
      const want = declaredBg(t.id);
      expect(want, `${t.id} に --bg が無い`).not.toBe('');
      applyTheme(document.documentElement, t.id);
      expect(m.content, `${t.id} の枠の色が地の色と違う`).toBe(want);
      seen.add(m.content);
    }
    // ⚠ 固定値へ戻す変異(全部同じ色)を殺す ── 10 配色の地は全部違う
    expect(seen.size, '配色を変えても枠の色が変わっていない').toBe(THEMES.length);
  });

  it('user が選んだときも枠の色が付いてくる', () => {
    const m = meta();
    chooseTheme(document.documentElement, 'terminal');
    expect(m.content).toBe(declaredBg('terminal'));
  });

  /**
   * ⚠ **器を新しく作らない** ── `<meta>` が無い document(書き出した HTML / 素の器)で
   *   勝手に足すと、身に覚えのない `<meta>` が増える。
   */
  it('meta が無い document では何も足さない', () => {
    document.head.textContent = '';
    applyTheme(document.documentElement, 'dark');
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(document.documentElement.getAttribute('data-pkc-theme')).toBe('dark');
  });
});
