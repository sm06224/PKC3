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
    // ⚠ **受けられる物はここに全部書く**(2 巡目の動線レビュー 2026-08-28)──
    //    vCard を足したのにこの字が変わっておらず、user は「対応していない」と読む
    //    (「在るのに見つけられないのは、こちらの動線の不備」── CLAUDE.md)
    title:
      'PKC2 の書き出し(HTML / ZIP)/ PKC3 のバックアップ(.pkc3.zip)/ Markdown / 連絡先(.vcf)を取り込みます',
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
    action: 'export-portable',
    label: '持ち歩ける 1 枚',
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
  /**
   * 🔴 **構成をテキストでコピー**(#429 段①)── AI に整理を頼むための材料。
   * ⚠ **「押す前に考える」側**なので設定へ置く(左下は「よく押す / 押せないと詰まる」)。
   * 🔑 書き出しの仲間である ── 出すのは file ではなくクリップボードだが、
   *   「PKC3 の外へ渡す形にする」という用事は `export-markdown` と同じ。
   */
  {
    action: 'export-structure',
    label: '構成をコピー',
    title:
      'ノートとフォルダの並びを、整理コマンドの書き方つきでクリップボードに入れます。AI に貼って「整理案を考えて」と頼めます',
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
  wrap.append(buildStorageProfile());
  wrap.append(buildPlanApply());
  wrap.append(buildSettingsFile());
  return wrap;
}

/**
 * 🔴 **設定だけを別の端末へ持っていく**(#414)。
 *
 * ⚠ **バックアップ(`.pkc3.zip`)とは別物である** ── あちらは**データごと**移るので、
 *   移した先のノートが混ざる。ここで運ぶのは**見た目と使い勝手だけ**である。
 * ⚠ **畳まない**(`<details>` を使わない ── user 指示 2026-08-03)。
 * 🔑 **何を運ぶか / 運ばないかは `features/settings/settings-file.ts` が 1 か所で持つ**
 *   ── ここは押し口と下見の器だけで、判断を 1 つも持たない(§7)。
 */
function buildSettingsFile(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'settings-file');
  const h = document.createElement('h4');
  h.textContent = '設定の持ち出し';
  h.title = '見た目・鍵の割当・紙面などを、別の端末へ持っていきます(ノートは移りません)';
  box.append(h);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'settings-file-note');
  note.textContent =
    '見た目・面の畳み方・編集の仕方・紙面・鍵の割当などを 1 つのファイルにします。ノートは入りません。許可とフラグとお知らせの既読は、その端末のものなので運びません。';
  box.append(note);

  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', 'settings-file-row');
  const out = iconButton('export-settings', '設定を書き出す');
  out.title = 'いまの設定を 1 つのファイルにして落とします';
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
   * ⚠ **「当てる」にしない** ── 同じ面に整理案の「当てる」が既に在り、
   *   **同じ字のボタンが 2 つ**並ぶと user はどちらか見分けられない
   *   (`docs-parity` の等値 pin が教えた ── 検査が正しい)。
   */
  apply.textContent = '設定を当てる';
  /**
   * 🔴 **変わるものが 1 件も無ければ押せない**(#414)。
   * ⚠ 既定は `disabled` ── 選ぶ前から押せる形にしない(dead click を作らない)。
   */
  apply.disabled = true;
  box.append(apply);
  return box;
}

/**
 * 🔴 **整理案を貼って、下見してから当てる**(#429 段③④)。
 *
 * ## ⚠ モーダルにしない(#429 の判定 2 段目 / #300 の裁定)
 *
 * 「貼って・見て・直して・押す」は**行き来する**ので、本文を退かす器に置くと
 * 直すたびに開き直すことになる。🔑 **書き出しの隣**に置く ── 案を出すのと
 * 当てるのは**同じ 1 つの用事の前半と後半**である(入口を 2 か所に散らさない)。
 *
 * ## 🔴 畳まない(user 指示 2026-08-03「主要な導線は全部見えている」)
 *
 * ⚠ 初稿は `<details>` で畳んでいたが、`tests/docs-parity.test.ts` の
 *   「**主要な導線を畳まない(業務画面の作法)**」が落とした ── **検査が正しい**。
 *   畳む理由に挙げた「片づけをしない日に場所を取る」は、user が
 *   **既に「高密度だが詰まっていない」側で裁定している**ことである。
 * 🔑 設定の面に在るので、そもそも主の作業領域は奪っていない。
 */
function buildPlanApply(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'plan-apply');
  const sum = document.createElement('h4');
  sum.textContent = '整理案を当てる';
  sum.title = 'AI から返ってきた整理案(mv / mkdir / rename)を貼ると、何が起きるかを先に見せます';
  box.append(sum);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'plan-note');
  note.textContent =
    '「構成をコピー」で出した内容を AI に渡し、返ってきた案をここへ貼ってください。当てる前に、何がどう動くかを全部お見せします。';
  box.append(note);

  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'plan-input');
  // ⚠ `data-pkc-action` は付けない ── 打鍵の受け口は `onInput` が
  //   **`data-pkc-field` で**拾う(`entry-filter` / `dual-filter` と同じ形)
  ta.rows = 6;
  ta.placeholder = 'mkdir "アーカイブ" as @arc';
  // ⚠ `placeholder` は名前ではない(値を入れると読み上げから消える)
  ta.setAttribute('aria-label', '整理案を貼る');
  box.append(ta);

  /** 誤りの一覧(行番号つき)。⚠ 空のときは畳む(空の枠を出さない)。 */
  const errs = document.createElement('ul');
  errs.setAttribute('data-pkc-field', 'plan-errors');
  errs.hidden = true;
  box.append(errs);

  /** 下見。⚠ 同上。 */
  const prev = document.createElement('ul');
  prev.setAttribute('data-pkc-field', 'plan-preview');
  prev.hidden = true;
  box.append(prev);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.setAttribute('data-pkc-action', 'apply-plan');
  apply.setAttribute('data-pkc-field', 'plan-apply');
  apply.textContent = '当てる';
  /**
   * 🔴 **誤りが 1 行でもあれば押せない**(#429 段③)。
   * ⚠ 半分だけ当たると、どこまで進んだのか user にも分からなくなる。
   * ⚠ 既定は `disabled` ── 貼る前から押せる形にしない(dead click を作らない)。
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
 */
function buildStorageProfile(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'storage-profile');
  const h = document.createElement('h4');
  h.textContent = '何が容量を食っているか';
  box.append(h);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'storage-profile');
  btn.setAttribute('data-pkc-field', 'storage-profile-run');
  btn.textContent = '調べる';
  btn.title = '添付の重い順にノートを並べます。押すとそのノートへ飛べます';
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
  return box;
}