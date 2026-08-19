/**
 * 🔴 **説明に添えるショートカットを、いまの割当から作る**(2026-08-19)。
 *
 * ## なぜ要るか
 *
 * ボタンの `title` に **`(Ctrl+N)` と直書き**していた場所が 6 か所あった。これは
 * 2 つの向きで嘘になる:
 *
 * 1. 🔴 **mac では既定のままでも 6/6 が食い違う** ── 画面は `Ctrl` と言うが、
 *    実際に効くのは `⌘` である(`chordLabel` は mac で `⌘` を出す)
 * 2. **user が割当を変えると嘘になる** ── 設定で変えられるようにしたのに、
 *    説明だけが最初の値のまま残る
 *
 * 🔑 **綴りは `chordLabel` 1 か所**(設定画面・ヘルプの一覧と同じ関数)。
 * ここは「どの命令の、いまの第 1 割当か」を引くだけにする。
 *
 * ## 使い方(描く側)
 *
 * 説明の**土台**と**命令 id** を属性で持たせておく:
 *
 * ```ts
 * btn.setAttribute('data-pkc-hint-base', 'この種類で新しく作ります');
 * btn.setAttribute('data-pkc-hint-command', 'create-entry');
 * ```
 *
 * あとは `applyShortcutHints(root, keymap)` が `title` を組み立てる。
 * ⚠ **割当が変わったら呼び直す**(`main.ts` が `onChange` で呼ぶ)──
 * 呼ばないと、変えた直後だけ古い綴りが残る。
 */
import { chordLabel } from '@features/keymap';
import { appKeymap, type KeymapStore } from './keymap';

/** 属性の名前(描く側と読む側で 1 か所に持つ)。 */
export const HINT_BASE = 'data-pkc-hint-base';
export const HINT_COMMAND = 'data-pkc-hint-command';

/**
 * その命令の**いまの第 1 割当**を画面の綴りで返す。⚠ 割当が 1 つも無ければ `null`
 * ── 呼び側は括弧ごと出さない(空の `()` を画面に出さない)。
 */
export function chordHint(commandId: string, keymap: KeymapStore = appKeymap): string | null {
  const chords = keymap.getBindings()[commandId] ?? [];
  const first = chords[0];
  return first === undefined ? null : chordLabel(first);
}

/** 説明の 1 行。⚠ 割当が無いときは**土台だけ**(括弧を出さない)。 */
export function hintTitle(
  base: string,
  commandId: string,
  keymap: KeymapStore = appKeymap,
): string {
  const hint = chordHint(commandId, keymap);
  return hint === null ? base : `${base}(${hint})`;
}

/**
 * 器の中の説明を、いまの割当で組み立て直す。
 * @returns 書き換えた数(⚠ test の空振り防止に使う ── 0 件なら誰も名乗っていない)
 */
export function applyShortcutHints(root: ParentNode, keymap: KeymapStore = appKeymap): number {
  const targets = root.querySelectorAll<HTMLElement>(`[${HINT_COMMAND}]`);
  let applied = 0;
  for (const el of targets) {
    const base = el.getAttribute(HINT_BASE);
    const id = el.getAttribute(HINT_COMMAND);
    if (base === null || id === null) continue;
    el.title = hintTitle(base, id, keymap);
    applied += 1;
  }
  return applied;
}

/**
 * 🔴 **boot での配線**(`main.ts` から取り出した ── 2026-08-19)。
 *
 * ⚠ `main.ts` は**どの test からも実行されない**ので、ここへ書かないと
 * 「割当を変えても説明が古いまま」の変異が誰にも殺されない
 * (CLAUDE.md §2「どの test からも実行されない file に、判断を書かない」)。
 * ⚠ **1 回目もここで撃つ** ── `onChange` だけだと、割当を 1 度も変えない
 *   user には直書きの綴りしか届かない。
 * @returns 購読の解除(⚠ アプリと同寿命なので `main.ts` は捨てる)
 */
export function wireShortcutHints(
  root: ParentNode,
  keymap: KeymapStore = appKeymap,
): () => void {
  applyShortcutHints(root, keymap);
  return keymap.onChange(() => applyShortcutHints(root, keymap));
}
