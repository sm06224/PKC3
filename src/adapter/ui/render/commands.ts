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
 * ここに 3 つ並べ、`tests/adapter/collection-commands.test.ts` が
 * **重なりが無いこと**と**合計が変わっていないこと**を pin する。
 *
 * ## 2026-09-21 追記(#1017 段④a。型システムで言い直した置き場)
 *
 * 🔑 「書き出す(コレクション全体)」は**コレクションという型の操作**なので、
 * 「何も選んでいない = コレクションを選んでいる」右の列(情報ペイン)へ移した
 * (`docs/development/ui-total-design-2026-09.md` §4.3)。⚠ 「設定」は
 * **好みを変える場所**であって、対象を選んで実行する操作の場所ではなかった
 * ── だから `COLLECTION_PANE_COMMANDS` を**3 本目の配列**として分けた。
 * ⚠ **押し口(`data-pkc-action`)は変えていない** ── 受け手は `binder.ts` の
 * 同じハンドラで、`root` への委譲で拾うのでどの面に描いても効く(§7 と同じ形)。
 */
import { iconButton } from './icons';
/**
 * 🔴 **壊れたときの 4 つの字は features が持つ**(#986 段③)── 断り文
 * (`db-corruption.ts`)と捨てる窓(`container-reset.ts`)も同じ字を指すので、
 * ここに書くと**引けない側が手で書く**ことになる(#996 と同じ型)。
 */
import {
  BACKUP_LABEL,
  CONTAINER_REBUILD_LABEL,
  CONTAINER_RESET_LABEL,
  DB_CHECK_LABEL,
} from '@features/storage/rescue-labels';

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
    label: 'ファイルを取り込む',
    // ⚠ **受けられる物はここに全部書く**(2 巡目の動線レビュー 2026-08-28)──
    //    vCard を足したのにこの字が変わっておらず、user は「対応していない」と読む
    //    (「在るのに見つけられないのは、こちらの動線の不備」── CLAUDE.md)
    /**
     * 🔴 **受けるバックアップの末尾を全部書く**(#1017 段④b)。⚠ 判定は
     *   manifest.format(中身)であって、この末尾は user への案内でしかない
     *   ── だから 3 種 + 旧形式を**全部**書く(1 つでも欠けると、探しても
     *   見つからず「対応していない」と読まれる)。
     */
    title:
      'PKC2 の書き出し(HTML / ZIP)/ PKC3 のバックアップ(.pkc3-full.zip / .pkc3-notes.zip / .pkc3-part.zip / 旧 .pkc3.zip)/ Markdown / 連絡先(.vcf)を取り込みます',
  },
  {
    action: 'export-archive',
    // 🔴 **ここが定義側**(`BACKUP_LABEL` の値そのもの)── 識別子で書くと、
    //   `scripts/operation-table.mjs` の登記簿スキャナ(`label: '([^']*)'`)が
    //   文字列リテラルしか拾えず、この登記だけ字が引けなくなる(空振り)。
    //   ⚠ 値は `BACKUP_LABEL` と**必ず同じ**にする ── 変わったらここも直す
    //   (features 側は逆にここから `BACKUP_LABEL` 経由で引く)。
    label: 'バックアップ',
    /**
     * 🔴 **中身を言う**(#1017 段④b の「3 か所で言う」の 1 つ目)。
     * ⚠ 保存領域に問題があるときは、この操作が自動で読める分だけを集めて
     *   `.pkc3-part.zip` に切り替える(下の `db-corruption.ts` の断り文と同じ経路)。
     */
    title: 'ノート・添付・つながり・履歴 を全部、元に戻せる形で保存します(.pkc3-full.zip)',
  },
] as const;

/**
 * 🔴 **コレクション全体を配る操作**(#1017 段④a)── 右の列(情報ペイン)の、
 * **何も選んでいないとき**(= コレクションを選んでいるとき)に出す。
 *
 * ⚠ **2026-09-21 まで `SETTINGS_COMMANDS` に混ざっていた**(#239)。
 * `docs-parity` の等値 pin(§4.3 の型の検算)で「同じ型の操作は同じ場所」に揃えた ──
 * これは「書き出す(コレクション全体)」という**コレクションの型の操作**であって、
 * 「好みを変える」設定の話ではなかった。
 *
 * - `export-structure` … **書き出しの仲間**。出すのは file ではなくクリップボードだが、
 *   「PKC3 の外へ渡す形にする」という用事は他の 3 つと同じ
 *
 * ⚠ **「整理案を適用」はこの配列に無い**(#1017 段④b)。`export-structure` の
 *   **すぐ隣**(下)に描くが、押すと貼り付け欄が開く器つきの操作なので、
 *   ここの一律なボタン + 説明の形には収まらない ── `inspector.ts` の
 *   `buildCollectionPane` が、この配列を描いた**直後**に手で組む。
 */
export const COLLECTION_PANE_COMMANDS: readonly CollectionCommand[] = [
  { action: 'export-html', label: '閲覧用 HTML で書き出す', title: '読むだけの 1 枚にまとめます' },
  {
    action: 'export-portable',
    label: 'HTML 1 枚で書き出す',
    /**
     * 🔴 **「閲覧用 HTML」との違いを、題名ではなく説明で言い切る**(#400 段④)。
     * ⚠ どちらも「HTML 1 枚」なので、**何が違うか**を書かないと選べない ──
     *   隣の `Markdown` が「押す理由が書いていなかった」で直された(#180 C-2)
     *   のと同じ形を、最初から作らない。
     */
    title:
      'PKC3 ごと 1 つの .html にまとめます。ダブルクリックで開いて、そのまま読み書きできます(添付も入ります)',
  },
  {
    action: 'export-markdown',
    label: 'Markdown で書き出す',
    /**
     * 🔴 **何のための形かを書く**(#180 の C-2、2026-08-24)。
     * ⚠ 直す前は「Markdown ファイルとして保存します」だけで、**押す理由**が
     *   書いていなかった ── user は「他の道具へ渡せる」ことに辿り着けない。
     * 🔑 #346(PDF)と**同じ形の欠け**である:道は在るのに**道しるべ**が無い。
     */
    title:
      '1 ノート = 1 つの .md にして zip で保存します。PKC3 を使わなくなっても読める形で、Pandoc など他のアプリにもそのまま渡せます',
  },
  /**
   * 🔴 **構成をテキストでコピー**(#429 段①)── AI に整理を頼むための材料。
   */
  {
    action: 'export-structure',
    label: '構成をコピー',
    title:
      'ノートとフォルダの並びを、整理コマンドの書き方つきでクリップボードに入れます。AI に貼って「整理案を考えて」と頼めます',
  },
] as const;

/**
 * **設定画面へ逃がしたもの**(#239)── どれも「押す前に考える」操作である。
 *
 * ⚠ **書き出し 4 つは 2026-09-21 に `COLLECTION_PANE_COMMANDS` へ移した**
 *   (#1017 段④a)── ここに残るのは「保存領域の片づけ」だけである。
 *
 * - `purge-orphan-assets` … 掃除。⚠ しかも**元に戻せない** ── 腰を据えて押す場所が正しい
 */
export const SETTINGS_COMMANDS: readonly CollectionCommand[] = [
  {
    action: 'purge-orphan-assets',
    label: '使っていない添付を消す',
    title: 'どのノートでも使っていない添付を消します(元に戻せません)',
  },
] as const;

/**
 * 🔑 **左下から逃がした操作**(#239、user 指示 2026-08-17
 * 「左下にあっても使う頻度が低いボタンは設定画面に逃すこと」)。
 *
 * ⚠ **畳んでいない** ── 2026-08-03 の「主要な導線は全部見えている」は生きている。
 * ここは面(region)なので、開けば 1 つとも見えて押せる。
 * ⚠ **押す口(`data-pkc-action`)は変えていない** ── 場所だけ移した。受け手は
 *   `binder.ts` の同じハンドラで、`root` への委譲で拾うのでこの面でも効く。
 * ⚠ 一覧は `commands.ts` の 1 か所が持つ(2 か所に書くと、片方から消して
 *   もう片方へ足し忘れたときに**動線が丸ごと消える**)。
 * ⚠ **書き出し 4 つ(閲覧用 HTML / 持ち歩ける HTML 1 枚 / Markdown / 構成をコピー)は
 *   ここに無い**(2026-09-21、#1017 段④a)── 右の列(何も選んでいないとき)へ移った。
 * ⚠ **整理案を適用(旧「整理案を適用する」)もここに無い**(2026-09-21、#1017 段④b)──
 *   「構成をコピー」と**同じ 1 つの用事の前半と後半**なので、右の列の隣へ移した
 *   (`inspector.ts` の `buildCollectionPane`)。
 *
 * ## 2026-09-21 追記(#1017 段③-1。型システムで言い直した置き場、2 回目)
 *
 * 🔴 **「書き出しと片づけ」という 1 つの h3 は廃止**(`ui-total-design-2026-09.md` §3.2)。
 * ⚠ ここに在った物は**型が 3 つ**に割れていた:
 * ① `SETTINGS_COMMANDS`(使っていない添付)/ `buildStorageProfile`(何が容量を使っているか)/
 *    `buildDbRescue`(中身が壊れていないか調べる)── 全部「**保存領域**」という型の値
 * ② `buildSettingsFile`(設定の持ち出し)── 「**設定**」という型の値。「システム」の
 *    「設定」h3 の下へ、`settings.ts` が直接呼んで置く(ここでは組み立てない)
 * ③ `buildContainerRepair`(旧見出し「壊れて直らないときの、最後の手」)──
 *    **見出しごと廃止**(評価語「最後の手」を含むため、`ui-total-design-2026-09.md`
 *    §6.1 の 6 条に抵触する)。押し口は「中身が壊れていないか調べる」の中の
 *    畳んだ箱へ移した(`buildDbRescue` が内部で呼ぶ)。
 * 🔑 だから `buildSettingsCommands()` はいまも 1 関数だが、**h3 を持たない**
 *   (呼び側の `settings.ts` が「保存領域」の h3 を組み、この関数の返す断片を
 *   このアプリのデータ・Office 表示 の間へ挟む)。
 */
export function buildSettingsCommands(): DocumentFragment {
  const frag = document.createDocumentFragment();
  // 🔴 容量を**先に**出す(#1017 段③-1、設計 doc §3.2 の並び)──
  //   「使っていない添付を消す」を押す前に、まずどれが重いかを知りたい
  frag.append(buildStorageProfile());
  frag.append(buildPurgeOrphanAssets());
  // 🔴 壊れの調べは片づけの**隣**に置く ── 「壊れた」と言われた人が最初に探す並び
  frag.append(buildDbRescue());
  return frag;
}

/**
 * 🔴 **使っていない添付を消す**(2026-09-21、#1017 段③-1)。
 *
 * ⚠ 直す前は「書き出しと片づけ」の下に**見出し無しで**ボタン 1 つだけ置かれていた。
 *   「保存領域」の中に他の h4(何が容量を使っているか / 中身が壊れていないか調べる)と
 *   並ぶので、**同じ形(見出し + 説明 + ボタン)**に揃える。
 */
function buildPurgeOrphanAssets(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'settings-purge-orphan');
  const h = document.createElement('h4');
  h.textContent = '使っていない添付';
  box.append(h);

  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', 'settings-command-row');
  for (const { action, label, title } of SETTINGS_COMMANDS) {
    const btn = iconButton(action, label);
    btn.title = title;
    row.append(btn);
  }
  box.append(row);
  return box;
}

/**
 * 🔴 **押し口だけを開閉する**(2026-09-21、#1017 段③-1)。⚠ `<details>` は
 * 使わない(`toggle-plan-apply` / `toggle-replace` と同じ作法)。
 *
 * ## なぜ畳むのか
 *
 * ⚠ 旧見出し「壊れて直らないときの、最後の手」は評価語・脅し語なので廃止した
 * (`ui-total-design-2026-09.md` §6.1)。⚠ ただし**中身(2 つのボタン)は消していない**
 * ── 取り消せない操作なので、**押す前に必ず 1 回踏ませる**入口として畳んだ形にする
 * (見出しではなく押し口で「もう一段深い」ことを言う)。
 *
 * ## ⚠ ここには判断を 1 つも置かない
 *
 * 押したときに何を出すか(説明の窓 / 合言葉)は `binder.ts` が、
 * 何を消す / 戻すかは `features/storage/container-{reset,rebuild}.ts` が持つ。
 * ここは**押し口だけ**である。
 */
function buildContainerRepair(): DocumentFragment {
  const frag = document.createDocumentFragment();

  const toggle = iconButton('toggle-container-repair', '作り直す・初期化する を出す');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.title = 'ここを押すと、入れ物を作り直す・初期化する の 2 つのボタンが出ます';
  frag.append(toggle);

  const box = document.createElement('div');
  /**
   * ⚠ 区画の名前は **`container-repair`**(2026-09-18 に `container-reset` から改名)
   * ── 2 段になった時点で、片方の名前で区画を呼ぶと**もう片方が見えなくなる**。
   * 🔑 押し口の名前(`container-reset-*` / `container-rebuild-*`)はそのままである。
   * ⚠ **見出し(h4)は持たない** ── `toggle` の字が見出しの役目を兼ねる。
   */
  box.setAttribute('data-pkc-region', 'container-repair');
  box.setAttribute('data-pkc-field', 'container-repair-box');
  box.hidden = true;

  /**
   * ⚠ **先に読ませる 1 行**(ボタンの `title` はホバーしないと読めない ──
   *   指で触る端末では**一生読まれない**)。
   * 🔑 **2 つに共通することだけ**をここに書く ── どちらが何をするかは
   *   それぞれのボタンの上に書く(混ぜると、どちらの話か読めない)。
   */
  const intro = document.createElement('p');
  intro.setAttribute('data-pkc-field', 'container-repair-note');
  intro.textContent =
    `どちらも、押しただけでは何も起きません ── 何が起きるかを出して、もう一度聞きます。先に左下の「${BACKUP_LABEL}」を押して手元に控えておくと、より安全です。`;
  box.append(intro);

  /**
   * 🔴 **上に置く**(user 裁定 2026-09-18)── 壊れた人がまず試すのはこちらである。
   * ⚠ 字は `features` から引く(#986 段③)── ここに手で書くと、
   *   断り文やマニュアルが**古い字を指したまま CI も緑**になる(#996 と同じ型)。
   */
  const rebuildNote = document.createElement('p');
  rebuildNote.setAttribute('data-pkc-field', 'container-rebuild-note');
  rebuildNote.textContent =
    'ノートと添付を残したまま、入れ物だけ作り直します。押すと、まず読めるノートをファイル(.pkc3.zip)にして手元へ落とし、そのあと同じ中身で戻します。落とせなかったときは、何も消さずに止まります。⚠ どのフォルダに入っていたか・ノート同士に付けた関係・履歴(前の版)は戻りません。';
  box.append(rebuildNote);

  const rebuild = document.createElement('button');
  rebuild.type = 'button';
  rebuild.setAttribute('data-pkc-action', 'container-rebuild');
  rebuild.setAttribute('data-pkc-field', 'container-rebuild-run');
  rebuild.textContent = CONTAINER_REBUILD_LABEL;
  rebuild.title = '読めるノートを集めて書き出してから、入れ物を作り直して同じ中身を戻します(添付はそのまま残ります)';
  box.append(rebuild);

  const rebuildSum = document.createElement('p');
  rebuildSum.setAttribute('data-pkc-field', 'container-rebuild-summary');
  rebuildSum.hidden = true;
  box.append(rebuildSum);

  /**
   * 🔴 **下に置く**(取り消せないほう)。⚠ **消さない** ── 作り直しても
   *   直らない相手が居るので、ここを畳むと**逃げ道が 1 つ無くなる**。
   */
  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'container-reset-note');
  note.textContent =
    `⚠ こちらは中身を全部消します。元に戻せません。上の「${CONTAINER_REBUILD_LABEL}」を試しても直らなかったときだけ押してください。`;
  box.append(note);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'container-reset');
  btn.setAttribute('data-pkc-field', 'container-reset-run');
  btn.textContent = CONTAINER_RESET_LABEL;
  btn.title = 'この入れ物のノートと添付を全部消して、空の状態から始めます(元に戻せません)';
  box.append(btn);

  const sum = document.createElement('p');
  sum.setAttribute('data-pkc-field', 'container-reset-summary');
  sum.hidden = true;
  box.append(sum);

  frag.append(box);
  return frag;
}

/**
 * 🔴 **設定だけを別の端末へ持っていく**(#414)。
 *
 * ⚠ **バックアップ(`.pkc3.zip`)とは別物である** ── あちらは**データごと**移るので、
 *   移した先のノートが混ざる。ここで運ぶのは**見た目と使い勝手だけ**である。
 * ⚠ **畳まない**(`<details>` を使わない ── user 指示 2026-08-03)。
 * 🔑 **何を運ぶか / 運ばないかは `features/settings/settings-file.ts` が 1 か所で持つ**
 *   ── ここは押し口と下見の器だけで、判断を 1 つも持たない(§7)。
 *
 * 🔴 **export する**(2026-09-21、#1017 段③-1)── 「設定」という型の値なので、
 *   `settings.ts` が「システム」の「設定」h3 の下へ**直接**呼んで置く
 *   (`buildSettingsCommands()`(保存領域)には含めない)。
 */
export function buildSettingsFile(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'settings-file');
  const h = document.createElement('h4');
  h.textContent = '設定の持ち出し';
  h.title = '見た目・ショートカットキーの割り当て・ページ設定などを、別の端末へ持っていきます(ノートは移りません)';
  box.append(h);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'settings-file-note');
  note.textContent =
    '見た目・ペインの畳み方・編集の仕方・ページ設定・ショートカットキーの割り当てなどを 1 つのファイルにします。ノートは入りません。許可とフラグとお知らせの既読は、その端末のものなので持っていきません。';
  box.append(note);

  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', 'settings-file-row');
  const out = iconButton('export-settings', '設定を書き出す');
  out.title = 'いまの設定を 1 つのファイルにして保存します';
  row.append(out);

  /**
   * ⚠ **読み込みは「選ぶ」だけ** ── 選んだ時点では**当てない**。
   *   何が変わるかを下に出してから、user が押す(取り消せない形を作らない)。
   */
  const pick = document.createElement('label');
  pick.setAttribute('data-pkc-field', 'settings-file-pick');
  const pickText = document.createElement('span');
  pickText.textContent = '設定を読み込む';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.setAttribute('data-pkc-field', 'settings-file-input');
  input.setAttribute('aria-label', '設定ファイルを選ぶ');
  pick.append(pickText, input);
  row.append(pick);
  box.append(row);

  /** 下見のまとめ。⚠ 空のときは畳む(空の枠を出さない)。 */
  const summary = document.createElement('p');
  summary.setAttribute('data-pkc-field', 'settings-file-summary');
  summary.hidden = true;
  box.append(summary);

  /** 何が変わるか。⚠ **値そのものは出さない**(鍵の割当も紙面も JSON で読めない)。 */
  const list = document.createElement('ul');
  list.setAttribute('data-pkc-field', 'settings-file-changes');
  list.hidden = true;
  box.append(list);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.setAttribute('data-pkc-action', 'apply-settings');
  apply.setAttribute('data-pkc-field', 'settings-file-apply');
  /**
   * ⚠ **「適用する」にしない** ── 同じ面に整理案の「適用する」が既に在り、
   *   **同じ字のボタンが 2 つ**並ぶと user はどちらか見分けられない
   *   (`docs-parity` の等値 pin が教えた ── 検査が正しい)。
   */
  apply.textContent = '設定を適用';
  /**
   * 🔴 **変わるものが 1 件も無ければ押せない**(#414)。
   * ⚠ 既定は `disabled` ── 選ぶ前から押せる形にしない(dead click を作らない)。
   */
  apply.disabled = true;
  box.append(apply);
  return box;
}

/**
 * 🔴 **何が容量を食っているか**(#415)。
 *
 * ⚠ 片づける口(「使っていない添付を消す」)は在るのに、**どれが重いか**が
 *   分からなかった ── 1 件ずつ開けば大きさは出るが、300 件は開けない。
 * ⚠ **畳まない**(`<details>` を使わない)── user 指示 2026-08-03。
 * 🔑 数えるのは worker の中。ここが受け取るのは**数字だけ**である。
 *
 * 🔴 **export する**(2026-09-21、#1017 段③-1)── `buildSettingsCommands()` から呼ぶ。
 */
export function buildStorageProfile(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'storage-profile');
  const h = document.createElement('h4');
  h.textContent = '何が容量を使っているか';
  box.append(h);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'storage-profile');
  btn.setAttribute('data-pkc-field', 'storage-profile-run');
  btn.textContent = '調べる';
  btn.title = '添付の重い順にノートを並べます。行を押すと、そのノートを開きます';
  box.append(btn);

  /** 合計の言い方。⚠ 空のときは畳む(空の枠を出さない)。 */
  const sum = document.createElement('p');
  sum.setAttribute('data-pkc-field', 'storage-profile-summary');
  sum.hidden = true;
  box.append(sum);

  const list = document.createElement('ul');
  list.setAttribute('data-pkc-field', 'storage-profile-list');
  list.hidden = true;
  box.append(list);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'storage-profile-shared');
  note.hidden = true;
  box.append(note);

  /**
   * 🔴 **ブラウザが言う本当の使用量**(#971 段②)。
   *
   * ⚠ 直す前は、この面が数えるのは**添付の合計だけ**で、しかもすぐ下に
   *   「ブラウザの数とは一致しない」と断ってあった ── つまり
   *   **本当の残りを知る道が 1 つも無かった**。ここがその 1 行である。
   */
  const quota = document.createElement('p');
  quota.setAttribute('data-pkc-field', 'storage-quota');
  quota.hidden = true;
  box.append(quota);
  return box;
}

/**
 * 🔴 **中身が壊れたときに、調べる口**(#971 段③)。
 *
 * ⚠ **ここが無いと「壊れました」で行き止まりになる** ── 2026-09-16 に
 *   「書き込みだけ止める」門を配ったとき、断り文に「直す手順へ」と書きながら
 *   その手順がどこにも無かった(同じ日に見つけて、この節を足した)。
 * 🚫 **「索引を組み直す」は置かない** ── 実測で 12 回とも同じ rc 11 で落ちたので、
 *   置いても**押した人に同じエラーを見せるだけ**である。
 *
 * 🔴 **2026-09-21(#1017 段④b)に、専用の取り出しボタン 2 つを退役させた**。
 *
 * ⚠ 直す前はここに「拾って、戻せる形で書き出す」「拾って、読める形で書き出す」の
 *   2 つが並んでいた。🔑 いまは**専用のボタンを持たない** ── 保存領域に問題が
 *   あるときは、左下の**バックアップ**と右の列の**Markdown**が自動で読める分だけを
 *   集めて `.pkc3-part.zip` で落とす(`src/adapter/ui/actions/export-archive.ts`)。
 *   「戻す道具と壊れの案内が別の場所にある」という非対称を、
 *   **いつもの道具が壊れているときだけ形を変える**ことで解消した。
 */
function buildDbRescue(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'db-rescue');
  const h = document.createElement('h4');
  h.textContent = '保存領域に問題が無いか調べる';
  box.append(h);

  const check = document.createElement('button');
  check.type = 'button';
  check.setAttribute('data-pkc-action', 'db-check');
  check.setAttribute('data-pkc-field', 'db-check-run');
  check.textContent = DB_CHECK_LABEL;
  check.title = '保存領域に問題が無いかを調べます。中身が多いと数分かかります';
  box.append(check);

  /**
   * 🔑 **見た目は既に在る物を使う**(`settings-note` ── 小さく、無彩色の控えめな字)。
   * ⚠ ここに残す 1 行だけは**次の一手を言う**(調べる → いつものバックアップが
   *   自動で読める分を集める、が上から順に読める)。
   */
  const checkNote = document.createElement('p');
  checkNote.setAttribute('data-pkc-field', 'db-check-run-note');
  checkNote.className = 'settings-note';
  checkNote.textContent =
    '保存領域に問題が無いかを調べます。中身が多いと数分かかります。何も書き換えません。' +
    `保存領域に問題があるときは、左下の「${BACKUP_LABEL}」を押すと、いつもどおり読める分だけを集めて書き出します。`;
  box.append(checkNote);

  /**
   * ⚠ **入れ物ごと戻す道具はここに無い** ── `db-check` の結果は
   *   `db-check-summary` / `db-check-detail` へ出るが、field 名は既存のまま
   *   (`db-rescue-*`)残す(改名すると `binder.ts` の 2 か所を同時に直す必要が出て、
   *   1 語の改名が本題を広げる ── §1「範囲を勝手に広げない」)。
   */
  const sum = document.createElement('p');
  sum.setAttribute('data-pkc-field', 'db-rescue-summary');
  sum.hidden = true;
  box.append(sum);

  const detail = document.createElement('ul');
  detail.setAttribute('data-pkc-field', 'db-rescue-detail');
  detail.hidden = true;
  box.append(detail);

  /**
   * 🔴 **「作り直す・初期化する」を、この h4 の中の畳んだ箱として置く**
   * (2026-09-21、#1017 段③-1。旧見出し「壊れて直らないときの、最後の手」は廃止)。
   * ⚠ 点検で問題が見つかったときは `binder.ts` の `db-check` が
   *   `container-repair-box` の `hidden` を外す(結果の表示と同じ経路)。
   */
  box.append(buildContainerRepair());
  return box;
}