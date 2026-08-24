/**
 * **ノート全体に対する操作**の置き場を 1 か所で決める(#239)。
 *
 * ## なぜ分けるのか(user 指示 2026-08-17)
 *
 * > 「**左下にあっても使う頻度が低いボタンは設定画面に逃すこと**」
 *
 * 左の列の下(`collection-bar`)は「アプリ / ノート全体への操作」が並ぶ場所だが、
 * **押す頻度が違うものが同じ密度で並んでいた**。頻度の低いものを設定へ移す。
 *
 * ⚠ **畳むのではない。** 2026-08-03 の user 指示「シンプルかつ高機能」= 主要な導線は
 * `<details>` に畳まず全部見えている、は**いまも生きている** ── 移した先の設定は
 * 面(region)であって畳んだ引き出しではなく、**開けば全部見えて押せる**。
 * `tests/smoke/layout.smoke.spec.ts` が両方(帯と設定)で「見えて押せる」を見る。
 *
 * ## なぜ 1 つの file なのか
 *
 * 🔴 **落ちても誰も気づかない形を作らない。** 2 か所へ書き分けると、片方から消して
 * もう片方へ足し忘れたとき **user から動線が丸ごと消える**(押す口が無い action は
 * `repo-hygiene` の「受け手のいない action」検査とは**逆向き**なので鳴らない)。
 * ここに 2 つ並べ、`tests/adapter/collection-commands.test.ts` が
 * **重なりが無いこと**と**合計が変わっていないこと**を pin する。
 */
import { iconButton } from './icons';

export interface CollectionCommand {
  readonly action: string;
  readonly label: string;
  readonly title: string;
}

/**
 * **左の列の下に残すもの**(よく押す / 押せないと詰まる)。
 *
 * - `import-file` … 初回に必ず要る。隠すと**最初の 1 回**が詰まる
 * - `export-archive` … 失うと困る操作なので、目に入る所に置く
 */
export const COLLECTION_COMMANDS: readonly CollectionCommand[] = [
  {
    action: 'import-file',
    label: '取り込む',
    title: 'PKC2 の書き出し(HTML / ZIP)/ PKC3 のバックアップ(.pkc3.zip)/ Markdown を取り込みます',
  },
  { action: 'export-archive', label: 'バックアップ', title: '元に戻せる形で保存します' },
] as const;

/**
 * **設定画面へ逃がしたもの**(#239)── どれも「押す前に考える」操作である。
 *
 * - `export-html` / `export-markdown` … **配るときだけ**押す(形を選ぶ操作)
 * - `purge-orphan-assets` … 掃除。⚠ しかも**元に戻せない** ── 腰を据えて押す場所が正しい
 */
export const SETTINGS_COMMANDS: readonly CollectionCommand[] = [
  { action: 'export-html', label: '閲覧用 HTML', title: '読むだけの 1 枚にまとめます' },
  {
    action: 'export-markdown',
    label: 'Markdown',
    /**
     * 🔴 **何のための形かを書く**(#180 の C-2、2026-08-24)。
     * ⚠ 直す前は「Markdown ファイルとして保存します」だけで、**押す理由**が
     *   書いていなかった ── user は「他の道具へ渡せる」ことに辿り着けない。
     * 🔑 #346(PDF)と**同じ形の欠け**である:道は在るのに**道しるべ**が無い。
     */
    title:
      '1 ノート = 1 つの .md にして zip で保存します。PKC3 を捨てても読める形で、Pandoc など他の道具にもそのまま渡せます',
  },
  {
    action: 'purge-orphan-assets',
    label: '使っていない添付を消す',
    title: 'どのノートからも参照されていない添付を削除します(元に戻せません)',
  },
] as const;

/**
 * 🔑 **左下から逃がした操作**(#239、user 指示 2026-08-17
 * 「左下にあっても使う頻度が低いボタンは設定画面に逃すこと」)。
 *
 * ⚠ **畳んでいない** ── 2026-08-03 の「主要な導線は全部見えている」は生きている。
 * ここは面(region)なので、開けば 3 つとも見えて押せる。
 * ⚠ **押す口(`data-pkc-action`)は変えていない** ── 場所だけ移した。受け手は
 *   `binder.ts` の同じ 3 つで、`root` への委譲で拾うのでこの面でも効く。
 * ⚠ 一覧は `commands.ts` の 1 か所が持つ(2 か所に書くと、片方から消して
 *   もう片方へ足し忘れたときに**動線が丸ごと消える**)。
 */
export function buildSettingsCommands(): HTMLElement {
  const wrap = document.createElement('section');
  wrap.setAttribute('data-pkc-region', 'settings-commands');
  const h = document.createElement('h3');
  h.textContent = '書き出しと片づけ';
  wrap.append(h);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'settings-note');
  note.textContent =
    '配るときと、片づけるときに使います。取り込みとバックアップは、いつでも押せるように左下に置いてあります。';
  wrap.append(note);

  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', 'settings-command-row');
  for (const { action, label, title } of SETTINGS_COMMANDS) {
    const btn = iconButton(action, label);
    btn.title = title;
    row.append(btn);
  }
  wrap.append(row);
  return wrap;
}
