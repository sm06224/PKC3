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
/**
 * 🔴 **壊れたときの 4 つの字は features が持つ**(#986 段③)── 断り文
 * (`db-corruption.ts`)と捨てる窓(`container-reset.ts`)も同じ字を指すので、
 * ここに書くと**引けない側が手で書く**ことになる(#996 と同じ型)。
 */
import {
  CONTAINER_RESET_LABEL,
  DB_CHECK_LABEL,
  RESCUE_ARCHIVE_LABEL,
  RESCUE_TEXT_LABEL,
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
    label: '持ち歩ける HTML 1 枚',
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
      '1 ノート = 1 つの .md にして zip で保存します。PKC3 を使わなくなっても読める形で、Pandoc など他のアプリにもそのまま渡せます',
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
    title: 'どのノートでも使っていない添付を消します(元に戻せません)',
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
  // 🔴 容量の隣に置く ── 「壊れた」と言われた人が最初に探すのはこの並びである
  wrap.append(buildDbRescue());
  // 🔴 拾う口の**すぐ下**に置く ── 「拾う → 捨てる → 戻す」が上から順に読める
  wrap.append(buildContainerReset());
  wrap.append(buildPlanApply());
  wrap.append(buildSettingsFile());
  return wrap;
}

/**
 * 🔴 **入れ物ごと捨てて、まっさらにする**(#986 段③。user 裁定 2026-09-16)。
 *
 * ## なぜ別の塊にするのか
 *
 * すぐ上の `db-rescue` の見出しは「**中身が壊れていないか調べる**」である ──
 * ⚠ **調べる所に、取り消せない操作を混ぜない**(押し間違いは見出しの読み違いから起きる)。
 * 🔑 だから見出しごと分け、**拾う口のすぐ下**に置く
 *   (壊れた人の手順が「調べる → 拾う → **捨てる** → 取り込む」で上から読める)。
 *
 * ## ⚠ ここには判断を 1 つも置かない
 *
 * 押したときに何を出すか(説明の窓 / 合言葉)は `binder.ts` が、
 * 何を消すかは `features/storage/container-reset.ts` が持つ。ここは**押し口だけ**。
 */
function buildContainerReset(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'container-reset');
  const h = document.createElement('h4');
  h.textContent = '中身を捨てて、まっさらにする';
  box.append(h);

  /**
   * ⚠ **先に読ませる 1 行**(ボタンの `title` はホバーしないと読めない ──
   *   指で触る端末では**一生読まれない**)。
   */
  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'container-reset-note');
  note.textContent =
    `直せないほど壊れたときの、最後の手です。先に上の「${RESCUE_ARCHIVE_LABEL}」で持ち出してから押してください。押しただけでは消えません ── 何が消えるかを出して、もう一度聞きます。`;
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
  return box;
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
  h.title = '見た目・ショートカットキーの割り当て・紙面などを、別の端末へ持っていきます(ノートは移りません)';
  box.append(h);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'settings-file-note');
  note.textContent =
    '見た目・ペインの畳み方・編集の仕方・紙面・ショートカットキーの割り当てなどを 1 つのファイルにします。ノートは入りません。許可とフラグとお知らせの既読は、その端末のものなので持っていきません。';
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
  sum.textContent = '整理案を適用する';
  sum.title = 'AI から返ってきた整理案(mv / mkdir / rename)を貼ると、何が起きるかを先に見せます';
  box.append(sum);

  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'plan-note');
  note.textContent =
    '「構成をコピー」で出した内容を AI に渡し、返ってきた案をここへ貼ってください。適用する前に、何がどう動くかを全部お見せします。';
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
  apply.textContent = '適用する';
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
 * 🔴 **中身が壊れたときの、調べる口と持ち出す口**(#971 段③)。
 *
 * ⚠ **ここが無いと「壊れました」で行き止まりになる** ── 2026-09-16 に
 *   「書き込みだけ止める」門を配ったとき、断り文に「直す手順へ」と書きながら
 *   その手順がどこにも無かった(同じ日に見つけて、この節を足した)。
 * 🚫 **「索引を組み直す」は置かない** ── 実測で 12 回とも同じ rc 11 で落ちたので、
 *   置いても**押した人に同じエラーを見せるだけ**である。
 *
 * 🔴 **そして「取り出す」だけでは、まだ行き止まりだった**(#986、2026-09-16)──
 *   出していたのが **.md 1 枚**なので、取り込んでも**ノートは 1 件**にしかならない
 *   (拾えた 4000 件が、戻すと 1 件になる)。だから**戻せる形**の口を足した。
 */
/**
 * 🔴 **ホバーしないと読めない説明を、判断の材料にしない**(user 指摘 2026-09-17)。
 *
 * user の求め(こちらの解釈):**取り消せない操作に関わる所は、説明的な画面にすること。**
 *
 * ⚠ 直す前、壊れたときの 3 つのボタンは**違いを `title` にしか書いていなかった** ──
 * 🔴 `title` は**指で触る端末では一生読まれない**(user はスマホでも読む)。
 * ⚠ しかも**すぐ下の「捨てる」の塊には常時見える説明が在る**ので、
 *   同じ面の中で説明の有無が食い違っていた。
 *
 * 🔑 **選び間違いは、捨てる直前に効く** ── 「読める形」だけ書き出して捨てた人は、
 *   戻すと**ノート 1 件**になる。つまりこの選択は**不可逆な操作の前提条件**である。
 *   だからここは「危険な操作」の側に数えて、説明を画面へ出す。
 *
 * ⚠ `title` は**消さない**(ホバーする人の情報を減らさない)。
 */
function rescueNote(field: string, note: string): HTMLElement {
  const p = document.createElement('p');
  // ⚠ 器は**ボタンごと**に分ける(1 本の長い段落にすると、どれの説明か読めない)
  p.setAttribute('data-pkc-field', `${field}-note`);
  /**
   * 🔑 **見た目は既に在る物を使う**(`settings-note` ── 小さく、無彩色の控えめな字)。
   * ⚠ 新しい規則を足さない ── 同じ面に**同じ役目で違う見た目**の字を作らない。
   * ⚠ すぐ下の「捨てる」の説明には**この class を付けない** ── あちらは
   *   取り消せない操作の**警告**なので、小さく薄くするのは向きが逆である。
   */
  p.className = 'settings-note';
  p.textContent = note;
  return p;
}

function buildDbRescue(): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', 'db-rescue');
  const h = document.createElement('h4');
  h.textContent = '中身が壊れていないか調べる';
  box.append(h);

  const check = document.createElement('button');
  check.type = 'button';
  check.setAttribute('data-pkc-action', 'db-check');
  check.setAttribute('data-pkc-field', 'db-check-run');
  check.textContent = DB_CHECK_LABEL;
  check.title = '壊れている所があるかを調べます。中身が多いと数分かかります';
  box.append(
    check,
    rescueNote(
      'db-check-run',
      '壊れている所があるかを調べます。中身が多いと数分かかります。何も書き換えません。',
    ),
  );

  /**
   * 🔴 **戻せる形で出す**(#986。user 指示 2026-09-16
   *   「原因がわからなくても復旧できるようにしてください」)。
   *
   * ⚠ **ここが先に来る** ── 壊れたときに user がやりたいのは
   *   「読む」ではなく「**元に戻す**」だからである。
   */
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.setAttribute('data-pkc-action', 'db-rescue-archive');
  restore.setAttribute('data-pkc-field', 'db-rescue-archive-run');
  restore.textContent = RESCUE_ARCHIVE_LABEL;
  restore.title =
    '読めるノートを集めて、「取り込む」から読み戻せるファイル(.pkc3.zip)にします';
  box.append(
    restore,
    // 🔑 **戻すならこちら**、を頭で言う(並んだ 2 つの違いはここだけである)
    rescueNote(
      'db-rescue-archive-run',
      '戻すならこちらです。.pkc3.zip にします。左の列の「取り込む」から読み込むと、ノートがノートとして戻ります。',
    ),
  );

  /**
   * ⚠ **こちらは消さない** ── 壊れているときに
   *   「とりあえず中身を読みたい」は、戻すのとは別の要求である
   *   (CLAUDE.md「記法を減らすことは、user の動線を減らすことである」)。
   * ⚠ ただし **取り込んでも 1 件にしかならない**ので、字でそう言う。
   */
  const rescue = document.createElement('button');
  rescue.type = 'button';
  rescue.setAttribute('data-pkc-action', 'db-rescue');
  rescue.setAttribute('data-pkc-field', 'db-rescue-run');
  rescue.textContent = RESCUE_TEXT_LABEL;
  rescue.title =
    '読めるノートを集めて 1 つの文章(.md)にします。⚠ 読むための形なので、取り込んでもノートは 1 件になります';
  box.append(
    rescue,
    /**
     * 🔴 **「戻せない」をここに書く。**
     * ⚠ 直す前はこれが `title` の中だけに在り、⚠ **指で触る端末では 1 度も
     *   読まれないまま**、これだけ書き出して捨てる人を作れた。
     */
    rescueNote(
      'db-rescue-run',
      'すぐ中身を読みたいときに。.md 1 枚にします。⚠ 取り込んでもノートは 1 件になるので、戻すためのものではありません。',
    ),
  );

  /**
   * 🔑 **選ばせない逃げ道を 1 行置く** ── 迷っている人は、迷ったまま片方だけ押す。
   * ⚠ **書き出しは中身を変えない**ことも書く ── 壊れていると聞いた直後の人は、
   *   「押したら余計に壊れるのでは」と思って何も押せなくなる。
   */
  const both = document.createElement('p');
  both.setAttribute('data-pkc-field', 'db-rescue-both');
  both.className = 'settings-note';
  both.textContent =
    '⚠ どちらにするか迷ったら、両方押してください。どちらも、いまの中身は 1 文字も変えません。';
  box.append(both);

  const sum = document.createElement('p');
  sum.setAttribute('data-pkc-field', 'db-rescue-summary');
  sum.hidden = true;
  box.append(sum);

  const detail = document.createElement('ul');
  detail.setAttribute('data-pkc-field', 'db-rescue-detail');
  detail.hidden = true;
  box.append(detail);
  return box;
}