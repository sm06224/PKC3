/** @vitest-environment happy-dom */
/**
 * 説明に添えるショートカットと、編集の面の名前(2026-08-19 の全数監査より)。
 *
 * 🔴 守る主張:
 * 1. **鍵の綴りを直書きしない** ── mac では既定のままでも `Ctrl` は嘘である
 * 2. **割当を変えたら説明も変わる** ── 変えられる物の説明が固定なら、必ず腐る
 * 3. **割当が無いときは括弧を出さない** ── 画面に空の `()` を出さない
 * 4. **編集の面は読み上げから見て無名でない**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import {
  HINT_BASE,
  HINT_COMMAND,
  applyShortcutHints,
  chordHint,
  hintTitle,
  wireShortcutHints,
} from '../../src/adapter/ui/render/shortcut-hint';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { codeOnly } from '../helpers/code-only';

/** その test だけの保存(共有の localStorage を汚さない)。 */
function memStore(): KeymapStore {
  const m = new Map<string, string>();
  return new KeymapStore({
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  });
}

describe('ショートカットの説明', () => {
  it('既定の割当から綴りを作る', () => {
    const k = memStore();
    expect(chordHint('create-entry', k), '第 1 割当が引けない').toBe('Alt + N');
    expect(hintTitle('新しく作ります', 'create-entry', k)).toBe('新しく作ります(Alt + N)');
  });

  it('🔴 割当を変えたら、説明も変わる', () => {
    const k = memStore();
    k.removeBinding('create-entry', 'Alt+N');
    expect(k.addBinding('create-entry', 'Alt+9'), '割当を変えられない(前提が崩れている)').toBeNull();
    expect(hintTitle('新しく作ります', 'create-entry', k)).toBe('新しく作ります(Alt + 9)');
  });

  /** ⚠ 空の `()` を画面に出さない(「全部外す」ができる以上、必ず起きる)。 */
  it('🔴 割当を全部外したら、括弧ごと出さない', () => {
    const k = memStore();
    k.removeBinding('create-entry', 'Alt+N');
    expect(chordHint('create-entry', k)).toBeNull();
    expect(hintTitle('新しく作ります', 'create-entry', k)).toBe('新しく作ります');
  });

  /**
   * 🔴 **器の中の説明を、いまの割当で組み立て直す。**
   * ⚠ boot で 1 回だけでは足りない ── 別タブで変えたときも呼び直す。
   */
  it('🔴 器を走査して title を書き直す(名乗った物だけ)', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const named = document.createElement('button');
    named.setAttribute(HINT_BASE, '新しく作ります');
    named.setAttribute(HINT_COMMAND, 'create-entry');
    const other = document.createElement('button');
    other.title = 'そのまま';
    root.append(named, other);

    const k = memStore();
    expect(applyShortcutHints(root, k), '1 つも書き換えていない(空振り)').toBe(1);
    expect(named.title).toBe('新しく作ります(Alt + N)');
    expect(other.title, '名乗っていない物まで書き換えた').toBe('そのまま');

    k.removeBinding('create-entry', 'Alt+N');
    k.addBinding('create-entry', 'Alt+9');
    applyShortcutHints(root, k);
    expect(named.title, '呼び直しても古い綴りのまま').toBe('新しく作ります(Alt + 9)');
  });

  /**
   * ⚠ **土台を名乗り損ねた物は触らない**(変異試験 C4 が生き延びて判明)。
   * 命令 id だけ付けて土台を忘れると、素直に組み立てると `null(Alt + N)` が
   * **画面に出る** ── 名乗りが半分の物は、書き換えないのが正しい。
   */
  it('🔴 土台を名乗っていない物は書き換えない', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const half = document.createElement('button');
    half.setAttribute(HINT_COMMAND, 'create-entry'); // ⚠ HINT_BASE を忘れている
    half.title = 'もとの説明';
    root.append(half);
    expect(applyShortcutHints(root, memStore()), '半端な名乗りを書き換えた').toBe(0);
    expect(half.title).toBe('もとの説明');
  });

  /**
   * 🔴 **割当が変わったら組み立て直す**(変異試験 C7 が生き延びて判明)。
   * ⚠ この配線は `main.ts` に在ったが、**どの test からも実行されない file** なので
   *   誰も守っていなかった ── 取り出して here で試す(CLAUDE.md §2)。
   */
  it('🔴 配線すると、割当を変えた瞬間に説明が追いつく', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const btn = document.createElement('button');
    btn.setAttribute(HINT_BASE, '新しく作ります');
    btn.setAttribute(HINT_COMMAND, 'create-entry');
    root.append(btn);

    const k = memStore();
    const off = wireShortcutHints(root, k);
    // ⚠ **1 回目**も撃つ(割当を 1 度も変えない user にも届く)
    expect(btn.title, '配線した時点で組み立てていない').toBe('新しく作ります(Alt + N)');
    k.removeBinding('create-entry', 'Alt+N');
    k.addBinding('create-entry', 'Alt+9');
    expect(btn.title, '割当を変えても説明が古いまま').toBe('新しく作ります(Alt + 9)');
    // ⚠ 外したら止まる(購読を返している証拠)
    off();
    k.removeBinding('create-entry', 'Alt+9');
    k.addBinding('create-entry', 'Alt+8');
    expect(btn.title, '外したのに動いている').toBe('新しく作ります(Alt + 9)');
  });

  /**
   * 🔴 **実際に描かれた器**で見る(ソースの grep ではなく)。
   * ⚠ 「属性を書いた」ことと「説明が組み立たった」ことは別である。
   */
  it('🔴 左の列のボタンが、いまの割当で説明している', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    const k = memStore();
    const n = applyShortcutHints(root, k);
    expect(n, '説明を名乗るボタンが 1 つも無い(空振り)').toBeGreaterThanOrEqual(3);
    const create = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    expect(create?.title).toBe('ノートを新しく作ります(Alt + N)');
    const back = root.querySelector<HTMLElement>('[data-pkc-action="nav-back"]');
    expect(back?.title).toBe('前に見ていたノートへ戻ります(Alt + ←)');
  });

  /**
   * 🔴 **鍵の綴りを直書きした説明が戻っていない**(2026-08-19)。
   * ⚠ 見るのは**実行する行**(コメントを落とす)── 直した理由を書いた注記に
   *   旧い綴りが入っているので、file 全体で見ると必ず落ちる(CLAUDE.md §1)。
   */
  it('🔴 title / placeholder に鍵の綴りを直書きしていない', () => {
    const files = [
      'src/adapter/ui/render/shell.ts',
      'src/adapter/ui/render/format-bar.ts',
      'src/adapter/ui/render/detail.ts',
      'src/adapter/ui/render/append-box.ts',
    ];
    for (const f of files) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      expect(code.length, `${f}: コメント落としが本体まで消した`).toBeGreaterThan(500);
      for (const m of code.matchAll(/(?:\.title\s*=|placeholder\s*=)\s*'([^']*)'/g)) {
        expect(m[1], `${f}: 説明に鍵の綴りを直書きしている ── ${m[1]}`).not.toMatch(
          /Ctrl|Alt\+|⌘|⌥/,
        );
      }
    }
  });
});

describe('編集の面の名前(読み上げ)', () => {
  /**
   * 🔴 **`data-pkc-field` は機械の名前で、読み上げには届かない。**
   * ⚠ `<textarea>` / `<input>` に `<label>` が無いので、名前が無いと
   *   編集の面が全部「編集」とだけ読まれる。
   */
  it('🔴 原文・題名・追記・行の欄がすべて名乗る', () => {
    /** field 名 → その直後に `aria-label` が続くこと。 */
    const want: readonly [string, string][] = [
      ['src/adapter/ui/render/detail.ts', 'editor-title'],
      ['src/adapter/ui/render/detail.ts', 'editor-body'],
      ['src/adapter/ui/render/row-swap.ts', 'row-source'],
      ['src/adapter/ui/render/append-box.ts', 'append-input'],
    ];
    for (const [file, field] of want) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      const marks = [...code.matchAll(new RegExp(`'data-pkc-field',\\s*'${field}'\\);`, 'g'))];
      expect(marks.length, `${file}: ${field} を作る所が見つからない(空振り)`).toBeGreaterThan(0);
      for (const m of marks) {
        const after = code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200);
        expect(after, `${file}: ${field} が読み上げから見て無名`).toContain("'aria-label'");
      }
    }
  });
});

/** 🔑 押せない理由は、変わるときだけ書く(#1087。左の列は状態が動くたびに全部のボタンへ当てる)。 */
describe('#1087 setBlocked は同じ値を書き直さない', () => {
  it('🔑 同じ理由で 2 回当てても、属性の変更は 1 回 ── 対照群: 理由が変われば書く / 外せば外す', async () => {
    const { setBlocked } = await import('../../src/adapter/ui/render/shortcut-hint');
    const el = document.createElement('button');
    document.body.append(el);
    const seen: string[] = [];
    const mo = new MutationObserver((recs) => {
      for (const r of recs) if (r.attributeName === 'data-pkc-blocked') seen.push(String(r.oldValue));
    });
    mo.observe(el, { attributes: true, attributeOldValue: true });
    setBlocked(el, '編集中です');
    setBlocked(el, '編集中です');
    await Promise.resolve();
    // 記録は「変える前の値」── 1 回目は無かった(null)
    expect(seen, '同じ理由を書き直した').toEqual(['null']);
    setBlocked(el, '取り込み中です');
    setBlocked(el, null);
    setBlocked(el, null);
    await Promise.resolve();
    mo.disconnect();
    expect(seen).toEqual(['null', '編集中です', '取り込み中です']);
    expect(el.hasAttribute('data-pkc-blocked'), '外したのに理由が残る').toBe(false);
    expect(el.disabled, '外したのに押せないまま').toBe(false);
  });
});
