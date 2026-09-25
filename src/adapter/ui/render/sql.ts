/**
 * 🔴 **SQL を打つ面**(#681 段②)。
 *
 * > user の言葉 2026-09-03:「**内蔵の sqlite を最大限活用したインスタントな
 * > csv や sqliteDB のクエリアプリ**」
 *
 * ## ⚠ **読むだけ**である
 *
 * ノートの正本は同じ sqlite の中に在るので、書き込みを通すと**取り消せない壊し方**が
 * できる。🔑 境は **engine** に置いてある(worker の `PRAGMA query_only` と
 * 進み具合の見張り)── 打つ前の字の門(`sql-guard.ts`)は「**断る理由を読める字で
 * 言う**」ためのもので、境ではない。
 *
 * ## ⚠ 打つ人が最初につまずく 3 つを、面に書いておく
 *
 * 同梱の sqlite を実測した結果(`tests/adapter/sqlite-capabilities.test.ts` が pin):
 * - **`REGEXP` は無い**(`LIKE` と `GLOB` は在る)
 * - **二重引用符は必ず列名**(`DQS=0`)── 文字列は単引用符で書く
 * - **日本語入力のままでも打てる**(全角は半角へ直してから走らせる。⚠ 文字列の
 *   中身は直さない ── 探したい字そのものだから)
 *
 * ⚠ **描画器は状態を持たない** ── 打ちかけの字は state に在るので、
 *   面を閉じて戻っても消えない。
 */
import type { AppState, SqlPageState } from '@adapter/state/app-state';
import { sqlSourcesOf } from '@features/query/sqlite-attachment';
import { sqlLineHtml } from '@features/query/sql-lines';
import { paintSqlEr } from './sql-er';
import { duckDbOnlySourcesOf, SQL_GUEST_EXTS } from '@features/query/sql-guest-source';
// 🔴 添付の .csv / .tsv / .xlsx も同じ選び所へ並べる(#854 段① / 段③)
import { csvAttachmentSourcesOf } from '@features/query/csv-attachment';
import { xlsxAttachmentSourcesOf } from '@features/query/xlsx-attachment';
// 🔴 手持ちのファイルを開く(#854 段②)
import { isSqlLocalFileLid, SQL_PICK_LOCAL_FILE_VALUE } from '@features/query/sql-local-file';
import { humanBytes } from '@features/human-bytes';
import { sqlExampleText, sqlPlaceholder, sqlRulesText, sqlTipText } from '@features/query/sql-tip';
import {
  SQL_ENGINE_LABEL,
  SQL_ENGINES,
  sqlEngineHint,
  sqlEngineOf,
  type SqlEngine,
} from '@features/query/sql-engine';
import {
  SQL_WINDOW_MIN,
  sqlWindowOf,
  type SqlWindow,
} from '@features/query/sql-window';

/** 表の値を字にする。⚠ `null` と空文字を**見分けられる**ようにする。 */
const cellText = (v: string | number | null): string => (v === null ? '(なし)' : String(v));

export class SqlRenderer {
  private readonly host: HTMLElement;
  /** 打つ欄。⚠ 1 度だけ組む ── 表の描き直しで作り直さない(打ちかけを失わせない)。 */
  private box: HTMLTextAreaElement | null = null;
  /** 色分けと行番号の層(#918 段②c/②d)。⚠ 打つ所ではない ── 見せるだけ。 */
  private layer: HTMLElement | null = null;
  /** 層に塗ってある字(⚠ 同じ字では組み直さない ── 打鍵ごとに DOM を捨てない)。 */
  private painted: string | null = null;
  private run: HTMLButtonElement | null = null;
  private note: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  /** 直前に描いた指紋。⚠ 同じなら触らない。 */
  private last = ' ';
  /**
   * 🔴 **開いた最初の 1 回だけ欄へ焦点**(2026-09-09 の動線レビュー)。
   * ⚠ 打つためだけに開く窓なので、まず欄を 1 回押させるのは手数が 1 つ多い。
   *   探す面(`search.ts`)が同じ作法を採っている ── そちらへ揃える。
   * ⚠ **1 回だけ** ── 答えが届くたびに奪い直すと、読んでいる最中に飛ぶ。
   */
  private focused = false;
  /** 「ノートへ」の口(答えが無いうちは押させない)。 */
  private save: HTMLButtonElement | null = null;
  /** 調べる相手の選び所(#681 段③ の 2 つ目)。 */
  private source: HTMLSelectElement | null = null;
  /**
   * 🔴 **どのエンジンで引くかの選び所**(#682 段②。user 裁定 2026-09-15 = §9 は A)。
   * ⚠ **選べるものが 2 つ以上あるときだけ出す** ── 1 つしか無い相手で出すと、
   *   押せるのに何も変わらない口になる(この repo がいちばん嫌う形)。
   *   🔑 在ることは案内文(`sqlTipText`)が知らせる。
   */
  private engine: HTMLSelectElement | null = null;
  /** 直前に組んだエンジンの選択肢の指紋(相手が変わったときだけ組み直す)。 */
  private engineKey: string | null = null;
  /** 案内の 1 段落(#681 F2 ── 相手に合わせて書き換える)。 */
  private tip: HTMLElement | null = null;
  /** 打ち方の約束(#682 段② ── engine に合わせて書き換える)。 */
  private rules: HTMLElement | null = null;
  /**
   * 直前に組んだ選択肢の指紋(添付が増減したときだけ組み直す)。
   * 🔴 **初期値は `null`**(#681 の着地前レビュー F5)── `''` にすると
   *   「相手が 1 つも無い」の指紋と**同じ**になり、**1 枚目の描画で枝ごと素通り**する。
   *   結果、`.sqlite` を 1 つも取り込んでいない人に**中身が空の選び所**が出ていた
   *   (「押しても何も無い口を作らない」と書いた当の行が、初回だけ走っていなかった)。
   */
  private sourceKey: string | null = null;
  /** 打ち始めても消えない手本(#837 K1)。⚠ 器は 1 度しか組まないので控えを持つ。 */
  private example: HTMLElement | null = null;
  /** 履歴の押し所(#918 段②a)。⚠ 憶えている字が無いうちは押させない。 */
  private history: HTMLButtonElement | null = null;
  /** file へ書き出す押し所(#918 段④)。⚠ 答えが無いうちは押させない。 */
  private toFile: HTMLButtonElement | null = null;
  /** いま何番目を見ているかの行(#918 段②a)。⚠ 空なら畳む。 */
  private historyNote: HTMLElement | null = null;
  /** つながり図の器(#918 段⑤)。⚠ 畳んでいる間は中を組まない。 */
  private erHost: HTMLElement | null = null;
  /** 図を開く / 閉じる押し所(#918 段⑤)。 */
  private erToggle: HTMLButtonElement | null = null;
  /**
   * 直前に描いた図の中身。⚠ **模型は同一性で見る**(中身の比較は表の数だけ走る)──
   * 採り直したときだけ別の物になるので、これで足りる。
   */
  private erModel: SqlPageState['er']['model'] | undefined = undefined;
  /**
   * 🔴 **直前に描いた「自分で引いた線」**(#918 段⑤d-1)。⚠ 模型と同じく
   *   同一性で見る ── 繋ぐ / 消すのたびに reducer が新しい配列を作るので、
   *   参照が変わったかどうかだけで「描き直す必要があるか」が言える。
   */
  private erMine: SqlPageState['er']['mine'] | undefined = undefined;
  /** 図の見え方の指紋(開閉 / 採っている最中か / 断りの字 / 繋ぐ入切 / ここからの列)。 */
  private erKey = '';
  /**
   * 🔴 **手で高さを決めたか**(#918 段②b)。決めたら**そちらが強い** ──
   * 打つたびに引き戻すと、掴んで広げた操作が**毎回取り消される**
   * (片道の操作を作らない ── user 指示 2026-08-23)。
   */
  /**
   * 🔴 **窓で描くための持ち物**(#918 段③)。
   * ⚠ `rows` は `AppState` の配列を**そのまま指す**(写さない)── 数万行を
   *   もう 1 本持つと、それだけで常駐が倍になる(2026-07-27 の不可侵指示)。
   */
  private rows: readonly (readonly (string | number | null)[])[] = [];
  private table: HTMLTableElement | null = null;
  private head: HTMLTableRowElement | null = null;
  private tbody: HTMLTableSectionElement | null = null;
  /** 実測した 1 行の高さ。⚠ **0 は「測れていない」** = 窓に入らない印である。 */
  private rowH = 0;
  /** いま描いてある窓。⚠ 同じ窓なら描き直さない(転がすたびの作り直しを避ける)。 */
  private drawn: SqlWindow | null = null;

  private handSized = false;
  /** 最後に高さを合わせたときの字。⚠ 同じ字で測り直さない(打鍵ごとの再計測を避ける)。 */
  private fitted: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  private ensureFrame(): HTMLElement {
    if (this.body !== null) return this.body;
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'sql-head');
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = 'SQL で調べる';
    const box = document.createElement('textarea');
    box.setAttribute('data-pkc-action', 'set-sql-text');
    box.setAttribute('data-pkc-field', 'sql-input');
    box.setAttribute('aria-label', '打つ SQL');
    box.placeholder = sqlPlaceholder(null);
    /**
     * 🔴 **握った鍵は、乗せたら読める所に書く**(user 裁定 2026-09-14
     *   「マウスを乗せたときだけ出す」)。
     * ⚠ `Tab` は**ふつう次の部品へ飛ぶ鍵**なので、握ったこと自体が驚きになる ──
     *   驚いた人がまず動かすのはマウスである。
     * ⚠ 案内文(`sql-rules`)へは足さない ── あの段落は 2026-09-09 に
     *   「6 文が続いて読み飛ばされる」ので 2 行に割った経緯がある(#837 K1)。
     * ⚠ ここは**割当を変えられない鍵**なので直書きでよい(`applyShortcutHints` は
     *   `data-pkc-hint-command` を持つ物だけを書き換える ── 上の「走らせる」と同じ)。
     */
    box.title =
      'Tab で字下げが入ります。この欄から出るには Shift+Tab か Esc。↑ ↓ で前に打った字が戻ります。';
    box.rows = 4;
    box.spellcheck = false;
    /**
     * 🔴 **掴んで高さを変えたら、そちらが強い**(#918 段②b)。
     *
     * ⚠ 見分けは**押して離したときの差**で採る ── `ResizeObserver` で高さの変化を
     *   見る形にすると、**窓の幅が変わっただけ**(= 折り返しが変わって高さが動く)でも
     *   「手で決めた」と読んでしまう(CLAUDE.md §4「観測点が放っておいても変わるなら、
     *   変化は届いた証拠にならない」)。
     * ⚠ 離すのは欄の外のことがある(速く引くと外れる)ので、**離すのは document で聞く**。
     */
    let grabbedAt = -1;
    box.addEventListener('pointerdown', () => {
      grabbedAt = box.offsetHeight;
    });
    box.ownerDocument.addEventListener('pointerup', () => {
      if (grabbedAt < 0) return;
      const moved = Math.abs(box.offsetHeight - grabbedAt) > 2;
      grabbedAt = -1;
      if (moved) this.handSized = true;
    });
    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'sql-bar');
    const run = document.createElement('button');
    run.type = 'button';
    run.setAttribute('data-pkc-action', 'run-sql');
    run.setAttribute('data-pkc-field', 'sql-run');
    run.textContent = 'SQL を走らせる';
    // 🔑 近道も出す(打ち終わって手を動かさずに走らせられる)
    run.title = 'Ctrl+Enter でも走ります';
    /**
     * 🔴 **答えをノートへ書き出す**(#681 段③ の 3 つ目)。
     * ⚠ 窓を閉じれば答えは消えるので、**残す道が要る** ── 無いと
     *   「調べられるが、持ち帰れない」で終わる。
     * ⚠ 答えが無いうちは**押せない**(押せるのに何も起きない口を作らない)。
     */
    const save = document.createElement('button');
    save.type = 'button';
    save.setAttribute('data-pkc-action', 'sql-to-note');
    save.setAttribute('data-pkc-field', 'sql-to-note');
    save.textContent = 'ノートへ書き出す';
    save.title = 'いま出ている答えを、新しいノートに書き出します';
    /**
     * 🔴 **調べる相手**(#681 段③ の 2 つ目)。既定は「この PKC のノート」。
     * ⚠ **どちらを調べているかが読めない**と、user は「ノートを数えたつもりで
     *   よその DB を数えていた」に気づけない ── だから常に画面に出す。
     */
    const source = document.createElement('select');
    source.setAttribute('data-pkc-action', 'set-sql-source');
    source.setAttribute('data-pkc-field', 'sql-source');
    source.setAttribute('aria-label', '調べる相手');
    /**
     * 🔴 **どのエンジンで引くか**(#682 段②)。
     * ⚠ 既定は**いまの sqlite** ── 選ばなければ、これまでどおり 1 ドットも変わらない。
     * 🔑 置き場は**調べる相手のすぐ隣**(裁定 A の字そのもの)。
     */
    const engine = document.createElement('select');
    engine.setAttribute('data-pkc-action', 'set-sql-engine');
    engine.setAttribute('data-pkc-field', 'sql-engine');
    engine.setAttribute('aria-label', 'どのエンジンで引くか');
    engine.hidden = true;
    /**
     * 🔴 **「手持ちのファイルを開く…」が押した先**(#854 段②)。
     * ⚠ **隠したまま置く** ── 選び所の一項目を選ぶと `binder.ts` がここを
     *   `click()` する(`office-pack-input` / `settings-file-input` と同じ作法)。
     * ⚠ **憶えない**(user 裁定 2026-09-12)── ここは選ぶたびに使い捨てる口で、
     *   選んだ file を溜める仕組みはどこにも持たない。
     */
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = SQL_GUEST_EXTS.join(',');
    fileInput.hidden = true;
    fileInput.setAttribute('data-pkc-field', 'sql-file-input');
    fileInput.setAttribute('aria-label', '手持ちのファイルを選ぶ');
    /**
     * 🔴 **構造をノートへ**(#918 段①。user 要望 2026-09-14「ai向けに構造吐き出したり」)。
     * ⚠ **答えが無くても押せる**(「ノートへ書き出す」との違い)── 構造は**打つ前**に要る物だから。
     * 🔑 字で「構造」と言い切る ── 「ノートへ書き出す」が 2 つ並ぶと、どちらが何か読めない。
     */
    const schema = document.createElement('button');
    schema.type = 'button';
    schema.setAttribute('data-pkc-action', 'sql-schema-to-note');
    schema.setAttribute('data-pkc-field', 'sql-schema-to-note');
    schema.textContent = '構造をノートへ書き出す';
    schema.title =
      'いま調べている相手の表・列・型・鍵・繋がり・行数を、ノート 1 枚にします(中身は入りません)。AI に貼るのに使えます。';
    /**
     * 🔴 **前に打った字を、押して選べる**(#918 段②a。user 裁定 2026-09-14)。
     *
     * ⚠ `↑` `↓` は**鍵盤のある人だけの近道**である ── スマホ / タブレットには
     *   その鍵が無いので、押し所が無いと**毎回打ち直し**になる
     *   (CLAUDE.md「マウスだけで完結し、キーボードは近道」)。
     * 🔑 一覧で出すと、**いま何番目を見ているか**が分からない問題も同時に消える
     *   (選ぶ前に全部見えるので)。
     * ⚠ **憶えている字が無いうちは押せない**(押せるのに何も起きない口を作らない)。
     */
    /**
     * 🔴 **つながり図を開く**(#918 段⑤。裁定 2026-09-15 = この窓の中に畳める欄)。
     *
     * ⚠ 「構造をノートへ」の**隣**に置く ── どちらも「打つ前に構造を見る」道具なので、
     *   離すと片方しか見つからない。
     * 🔑 字は「**見る**」と「**閉じる**」で入れ替える ── 同じ字のままだと、
     *   開いているのにもう一度押して**閉じる**ことに気づけない(#300 の帰り道と同じ形)。
     */
    const er = document.createElement('button');
    er.type = 'button';
    er.setAttribute('data-pkc-action', 'sql-er-toggle');
    er.setAttribute('data-pkc-field', 'sql-er-toggle');
    er.textContent = '構造を見る';
    er.title = '表のつながりを図で出します。四角や線を押すと、下の欄に SQL が書かれます。';
    const erHost = document.createElement('div');
    erHost.setAttribute('data-pkc-region', 'sql-er');
    erHost.hidden = true;

    const history = document.createElement('button');
    history.type = 'button';
    history.setAttribute('data-pkc-action', 'sql-history-menu');
    history.setAttribute('data-pkc-field', 'sql-history');
    history.textContent = '履歴から選ぶ';
    history.title = '前に走らせた SQL を一覧から選びます(↑ ↓ でも戻せます)';
    /**
     * 🔴 **答えを file へ書き出す**(#918 段④。user 要望 2026-09-14「`copy to` 使えないし」)。
     *
     * ⚠ 直す前の持ち帰り方は「**ノートへ書き出す**」の 1 本だけで、表計算や別の道具へ渡したい人は
     *   **画面から手で写す**しかなかった。
     * 🔑 **押し所は 1 つ**にして、形(csv / tsv / json)は**一覧から選ばせる** ──
     *   帯にボタンを 3 つ並べると、いちばんよく使う「SQL を走らせる」が押しにくくなる。
     * ⚠ **答えが無いうちは押せない**(「ノートへ書き出す」と同じ ── 押せるのに何も起きない口を作らない)。
     */
    const toFile = document.createElement('button');
    toFile.type = 'button';
    toFile.setAttribute('data-pkc-action', 'sql-export-menu');
    toFile.setAttribute('data-pkc-field', 'sql-to-file');
    toFile.textContent = 'ファイルへ書き出す';
    toFile.title = 'いま出ている答えを、file に書き出します(CSV / TSV / JSON)';
    bar.append(run, save, toFile, schema, er, history, source, engine, fileInput);
    const tip = document.createElement('p');
    tip.setAttribute('data-pkc-field', 'sql-tip');
    /**
     * ⚠ **実測したことだけ書く**(`sqlite-capabilities.test.ts` が pin している)。
     * ⚠ 記法は書かない(`textContent` なので記号がそのまま出る)。
     */
    /**
     * 🔴 **1 行目は「何が調べられるか」**(2026-09-09 の動線レビュー)。
     * ⚠ 初稿は落とし穴だけを並べていたので、**表の名前が 1 つも出ていなかった** ──
     *   唯一の手掛かりは薄字の例文で、それは **1 文字打った瞬間に消える**。
     */
    // 🔴 中身は `render` が揃える(#681 F2)── 相手が変われば案内も手本も変わる
    tip.textContent = sqlTipText(null);
    /**
     * 🔴 **打ち方の約束は 2 行目へ**(#837 K1、2026-09-09)。
     * ⚠ 直す前は 6 文が 1 段落に続いていて、**読み飛ばされる長さ**だった。
     */
    const rules = document.createElement('p');
    rules.setAttribute('data-pkc-field', 'sql-rules');
    // 🔴 中身は `render` が揃える(#682 段② ── engine ごとに約束が違う)
    rules.textContent = sqlRulesText('sqlite');
    this.rules = rules;
    /**
     * 🔴 **打ち始めても消えない手本**(#837 K1)。
     * ⚠ 薄字(`placeholder`)は **1 文字打った瞬間に消える**ので、
     *   「打つために開く面」なのに**打つ物の見本が画面から無くなって**いた。
     */
    const example = document.createElement('p');
    example.setAttribute('data-pkc-field', 'sql-example');
    example.textContent = sqlExampleText(null);
    /**
     * 🔴 **いま何番目を見ているか**(#918 段②a。user 裁定 2026-09-14
     *   「欄の下に 2/3 と出す」)。
     *
     * ⚠ 直す前は `↑` を押しても画面が **1 バイトも動かなかった** ──
     *   いちばん古い所まで来ても無言なので、「これ以上前が無い」のか
     *   「鍵が効いていない」のか user には区別が付かない(無言の dead click)。
     * 🔑 **空なら畳む**(`hidden`)── 何も起きていないときに行を占めない。
     */
    const historyNote = document.createElement('p');
    historyNote.setAttribute('data-pkc-field', 'sql-history-note');
    historyNote.hidden = true;
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'sql-note');
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'sql-body');
    /**
     * 🔴 **色分けと行番号の層**(#918 段②c/②d)。
     *
     * 🔑 **打つ所は `textarea` のまま** ── 後ろにこの層を敷き、`textarea` の字だけ
     *   透明にする。器を替えると **IME・取り消し・選択・スマホの鍵盤**、そして
     *   段②a / 段②b が全部落ちる(CLAUDE.md §10「置き換えの作法」)。
     * 🔑 層は**論理行 1 本 = 升 1 つ**の格子にする ── 折り返した行は升ごと伸びるので、
     *   番号は自然に先頭へ揃う。⚠ 番号を「行の高さぶんずつ」積む形にすると、
     *   **折り返した瞬間にずれる**。
     * ⚠ **押しを通す**(`pointer-events: none`)── 当てないと `textarea` を押せない。
     *   ⚠ ここは #530 段③a と違い、**層が打つ所の真上に重なる**ので、
     *   規則が消えた瞬間に**欄がまるごと死ぬ**(無言の dead click そのもの)。
     */
    const wrap = document.createElement('div');
    wrap.setAttribute('data-pkc-field', 'sql-input-wrap');
    const layer = document.createElement('pre');
    layer.setAttribute('data-pkc-field', 'sql-input-layer');
    layer.setAttribute('aria-hidden', 'true');
    wrap.append(layer, box);
    /**
     * 🔴 **日本語入力の最中は、層を退けて字の色を戻す**(#918 段②c/②d)。
     *
     * ⚠ 打っている途中の字は **`value` に入らない** ── ブラウザが `textarea` の中へ
     *   直に描く。だから字を透明にしたままだと、**打っている字が 1 文字も見えない**。
     * 🔑 CLAUDE.md §2「入力を受ける機能は、日本語で打った形を fixture に必ず 1 つ持つ」
     *   (#764)と同じ型 ── ASCII だけで組むと、この経路を 1 度も通らない。
     * ⚠ **実 IME はこちらでは測れない** ── 実機確認は #438 Q3 に足す。
     */
    box.addEventListener('compositionstart', () => {
      wrap.setAttribute('data-pkc-composing', '');
    });
    box.addEventListener('compositionend', () => {
      wrap.removeAttribute('data-pkc-composing');
    });
    // ⚠ 欄が転がったら層も同じだけ動かす(上限に当たると欄自身が転がる)
    box.addEventListener('scroll', () => {
      layer.scrollTop = box.scrollTop;
      layer.scrollLeft = box.scrollLeft;
    });
    head.append(title, erHost, wrap, historyNote, bar, tip, rules, example);
    this.host.append(head, note, body);
    this.box = box;
    this.layer = layer;
    this.run = run;
    this.save = save;
    this.source = source;
    this.engine = engine;
    this.example = example;
    this.tip = tip;
    this.history = history;
    this.historyNote = historyNote;
    this.erHost = erHost;
    this.erToggle = er;
    this.toFile = toFile;
    this.note = note;
    this.body = body;
    /**
     * 🔴 **転がったら窓を描き直す**(#918 段③)。
     * ⚠ 張るのは**器を作るときの 1 度だけ** ── 答えごとに張り替えると、
     *   外し忘れた 1 本が古い表を掴んだまま残る(#195 と同じ形)。
     * 🔑 `repaint()` は**窓が変わっていなければ何もしない**ので、
     *   転がすたびに表を作り直すことにはならない。
     * ⚠ `passive` にする ── ここで転がりを止めることは無い。
     */
    body.addEventListener('scroll', () => {
      this.repaint();
    }, { passive: true });
    /**
     * 🔴 **state が 1 ミリも動かない変化も拾う**(#918 段③、着地前レビュー)。
     * ⚠ 窓そのものを広げる / 面を出し入れする / 開発者ツールを閉じる ──
     *   どれも `render()` を呼ばないので、上の 2 つ(答えが来た / 転がした)では
     *   **1 度も届かない**。
     * ⚠ 持たない環境がある(古い箱)ので**在るときだけ**張る ── 無くても
     *   `render()` 側と `scroll` 側が拾うので、落ちるのは「触らずに器だけ変わった」場合だけ。
     */
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        this.repaint();
      }).observe(body);
    }
    return body;
  }

  /**
   * 🔴 **調べる相手の選び所を揃える**(#681 段③ の 2 つ目、#854 段①②)。
   *
   * ⚠ **選択肢は添付が増減したときだけ組み直す** ── 毎回作り直すと、
   *   開いたまま増えた添付に気づける代わりに、**選んでいる最中に選択肢が
   *   差し替わる**(押している指の下で並びが動く)。
   * ⚠ **いま選ばれている物は `guestChosen` から書き戻す**(`guest?.lid` ではない)。
   *   開いている最中や、開けなかった回も `guest` は `null` のままなので、
   *   `guest?.lid` だけを見ると選び所が**開いている最中や失敗した瞬間**に
   *   「この PKC」へ戻ってしまう(user 報告:「プルダウンには出てくるのに、
   *   取り込み済みの csv が選択できない」── 実は選べていたが、描画が戻していた)。
   *   `guestChosen` は `SET_SQL_SOURCE` でしか書き換わらないので、選んだ物は
   *   開いた・失敗した・まだ開いている、のどれでも画面に出したまま残る。
   * 🔑 **`.sqlite` の下に `.csv` / `.tsv`、その下に `.xlsx`、いちばん下に
 *   `.parquet` / `.json`**(#854 段① / 段③、#682 段④c)──
   *   開く仕組みは `sqlGuestSourceOf` が `name` の拡張子だけで見分けるので、
   *   ここは一覧を**連結するだけ**でよい(判定を 2 か所に置かない)。
   * ⚠ **並べたものは必ず開けなければならない** ── 選び所に出したのに
   *   `sqlGuestSourceOf` が知らない拡張子だと、押した瞬間に断られる
   *   (無言の dead click に近い)。両者が同じ 1 つの判定を見ていることは
   *   `tests/adapter/sql-source-parity.test.ts` が見る。
   */
  private paintSource(state: AppState): void {
    const sel = this.source;
    if (sel === null) return;
    const sources = [
      ...sqlSourcesOf(state.entryMetas.values()),
      ...csvAttachmentSourcesOf(state.entryMetas.values()),
      ...xlsxAttachmentSourcesOf(state.entryMetas.values()),
      // 🔴 DuckDB でしか読めない相手(`.parquet` / `.json` / `.ndjson` / `.jsonl`。#682 段④c)
      ...duckDbOnlySourcesOf(state.entryMetas.values()),
    ];
    /**
     * 🔴 **いま開いている手持ちのファイルも一覧へ足す**(#854 段②)。
     * ⚠ 足さないと、開いた file を表す `<option>` が一覧に無いまま `want` だけ
     *   それを指し、すぐ下の「いま選ばれている物は state から書き戻す」が
     *   選び所を「この PKC」へ戻してしまう(画面と実体が食い違う ── この file
     *   自身のいちばん上のコメントが戒めている形)。
     * ⚠ **entryMetas には出てこない** ── ノートでも添付でもないので、
     *   開いている間だけこの場で足す(閉じれば消える。「憶えない」の裁定どおり)。
     */
    const guest = state.sqlPage.guest;
    if (guest !== null && isSqlLocalFileLid(guest.lid)) sources.push(guest);
    const key = sources.map((s) => `${s.lid}:${s.name}`).join('|');
    if (key !== this.sourceKey) {
      this.sourceKey = key;
      sel.textContent = '';
      const here = document.createElement('option');
      here.value = '';
      here.textContent = 'この PKC のノート';
      sel.append(here);
      for (const s of sources) {
        const opt = document.createElement('option');
        opt.value = s.lid;
        opt.textContent = s.name;
        sel.append(opt);
      }
      /**
       * 🔴 **「手持ちのファイルを開く…」は常に置く**(#854 段②)。
       * ⚠ 添付が 1 つも無くても**この項目だけは押せる**ので、上の
       *   「選べる相手が 1 つも無いときは出さない」は成り立たなくなった ──
       *   選び所そのものは**もう隠さない**(実体の無い口ではなく、押せば file
       *   選択画面が開く実在する操作である)。
       */
      const pick = document.createElement('option');
      pick.value = SQL_PICK_LOCAL_FILE_VALUE;
      pick.textContent = '手持ちのファイルを開く…';
      sel.append(pick);
      sel.hidden = false;
    }
    const want = state.sqlPage.guestChosen;
    if (sel.value !== want) sel.value = want;
  }

  /**
   * 🔴 **どのエンジンで引くかの選び所を揃える**(#682 段② → **段③c で作り替えた**)。
   *
   * ## ⚠ 直す前はこうだった ── **選べる物が 1 つの相手では、選び所ごと消えていた**
   *
   * 「選んでも何も変わらない口を作らない」という理屈で `hidden` にしていたが、
   * 🔴 user 報告 2026-09-16 は「**duckdb の導線が無い**」だった ──
   * 取り込んだ `.csv` を選んでいる間しか存在しないので、**探しても見つからない**。
   * 🔑 **消す作りが、そのまま「無い」に見えていた。**
   *
   * ## いまの形
   *
   * **常に全部を並べ、選べない側は薄い字(`disabled`)にして、隣に理由を書く。**
   * ⚠ `disabled` な `option` は**選べない**ので、無言の dead click にはならない。
   * ⚠ **いま選ばれている物は `sqlEngineOf` から書き戻す** ── state が持つのは
   *   「user が選んだ物」で、相手によっては成り立たない。画面には**実際に引く物**を出す
   *   (画面と実体を食い違わせない ── この file の上のほうと同じ規律)。
   *
   * 🔑 **組み直す合図は「理由まで込みの指紋」** ── 相手が `.csv` から `.xlsx` へ
   *   変わると、並ぶ物の数は同じでも**理由の字が変わる**。数だけを鍵にすると、
   *   **前の相手の理由が残る**。
   */
  private paintEngine(state: AppState): void {
    const sel = this.engine;
    if (sel === null) return;
    const name = state.sqlPage.guest?.name ?? null;
    const hints = SQL_ENGINES.map((e) => sqlEngineHint(e, name));
    const key = hints.map((h) => h ?? '').join('|');
    if (key !== this.engineKey) {
      this.engineKey = key;
      sel.textContent = '';
      SQL_ENGINES.forEach((e, i) => {
        const hint = hints[i] ?? null;
        const opt = document.createElement('option');
        opt.value = e;
        opt.textContent = hint === null ? SQL_ENGINE_LABEL[e] : `${SQL_ENGINE_LABEL[e]} ── ${hint}`;
        opt.disabled = hint !== null;
        sel.append(opt);
      });
      sel.hidden = false;
    }
    const want = sqlEngineOf(state.sqlPage);
    if (sel.value !== want) sel.value = want;
  }

  render(state: AppState): void {
    const body = this.ensureFrame();
    const p = state.sqlPage;
    // ⚠ 打ちかけの字は**上書きしない**(state が直した字を返したときだけ揃える)
    if (this.box !== null && this.box.value !== p.sql) this.box.value = p.sql;
    if (this.run !== null) this.run.disabled = p.running;
    /**
     * 🔴 **履歴の合図は指紋の門より前で塗る**(#918 段②a)。
     * ⚠ 下の `fingerprint` は「答えが変わったか」を見る物で、`↑` `↓` では
     *   **1 バイトも動かない** ── 門の後ろに置くと、押しても行が出ない。
     */
    /**
     * 🔴 **打った行数に合わせて伸ばす**(#918 段②b)。
     * ⚠ **指紋の門より前**で塗る ── 打っただけでは答えの指紋が動かない(段②a と同じ)。
     * ⚠ **同じ字では測り直さない** ── 打鍵ごとに `scrollHeight` を読むと毎回 layout が走る。
     * ⚠ 手で決めた高さが在るなら、こちらは何もしない。
     */
    if (this.box !== null && !this.handSized && this.fitted !== p.sql) {
      this.fitted = p.sql;
      fitSqlInput(this.box);
    }
    /**
     * 🔴 **層を塗り直す**(#918 段②c/②d)。⚠ **指紋の門より前**
     *   ── 打っただけでは答えの指紋が動かない(段②a / 段②b と同じ理由)。
     * ⚠ **同じ字では組み直さない** ── 打鍵ごとに升を作り直すと、
     *   選択や焦点とは無関係でも**毎回 layout が走る**。
     */
    if (this.layer !== null && this.painted !== p.sql) {
      this.painted = p.sql;
      paintSqlLayer(this.layer, p.sql);
    }
    /**
     * 🔴 **つながり図を塗り直す**(#918 段⑤)。⚠ **指紋の門より前**
     *   ── 図を開いても答えの指紋は 1 バイトも動かない(段②a〜②d と同じ理由)。
     * ⚠ **同じ図を組み直さない** ── 模型は採り直したときだけ別の物になるので、
     *   同一性で足りる(中身を比べると表の数だけ走る)。
     */
    if (this.erToggle !== null) {
      const label = p.er.open ? '構造を閉じる' : '構造を見る';
      if (this.erToggle.textContent !== label) this.erToggle.textContent = label;
      this.erToggle.setAttribute('aria-expanded', p.er.open ? 'true' : 'false');
    }
    /**
     * 🔴 **繋ぐモード / ここからの列も指紋に入れる**(#918 段⑤d-1)。
     * ⚠ 入れないと、繋ぐを押しても「印」も「案内」も画面に出ない
     *   (state は動いているのに、描き直しの門が閉じたままになる)。
     */
    const pendingKey = p.er.pendingFrom === null ? '' : JSON.stringify(p.er.pendingFrom);
    const erKey = `${String(p.er.open)} ${String(p.er.loading)} ${p.er.note} ${String(p.er.connecting)} ${pendingKey}`;
    if (
      this.erHost !== null &&
      (this.erModel !== p.er.model || this.erMine !== p.er.mine || this.erKey !== erKey)
    ) {
      this.erModel = p.er.model;
      this.erMine = p.er.mine;
      this.erKey = erKey;
      paintSqlEr(this.erHost, p.er);
    }
    /**
     * 🔴 **器の高さが変わったら窓を見直す**(#918 段③、着地前レビューが出した)。
     *
     * 🔴 **指紋の門より前に置く。** ⚠ ここを門の後ろに置くと、いちばん多い経路で
     *   効かない ── すぐ上の `fitSqlInput` は**打つたびに欄の高さを変える**ので、
     *   同じ flex 列に居る `sql-body` の高さも一緒に動く。答えは変わっていないので
     *   指紋は動かず、門の後ろでは 1 度も通らない。
     * 🔴 実害は**打った字を消したとき**に出る ── 欄が縮んで器が広がるのに、
     *   描いてある行は狭かった頃のままなので、**広がった分が白い帯**になる
     *   (1px でも転がせば直るが、それまでは「答えが足りない」ように見える)。
     * 🔑 `repaint()` は**窓が変わっていなければ何もしない**ので、毎回呼んでよい。
     */
    this.repaint();
    if (this.history !== null) this.history.disabled = p.history.length === 0;
    if (this.historyNote !== null) {
      const line = historyNoteLine(p);
      if (this.historyNote.textContent !== line) this.historyNote.textContent = line;
      this.historyNote.hidden = line === '';
    }
    /**
     * ⚠ **押せるのに何も起きない口を作らない** ── まだ走らせていない回と、
     *   走っている最中は押させない(押した後に「何も起きなかった」を作らない)。
     */
    /**
     * ⚠ **押せるのに何も起きない口を作らない** ── まだ走らせていない回と、
     *   走っている最中は押させない(押した後に「何も起きなかった」を作らない)。
     * 🔑 **「ノートへ」と「ファイルへ」は同じ 1 本から採る**(§7)── 片方だけ
     *   押せる状態を作らない(どちらも「いま出ている答え」を持ち帰る口である)。
     */
    const canTakeAnswer = !p.running && p.ranSql !== '' && p.columns.length > 0;
    if (this.save !== null) this.save.disabled = !canTakeAnswer;
    if (this.toFile !== null) this.toFile.disabled = !canTakeAnswer;
    this.paintSource(state);
    /**
     * 🔴 **案内も手本も、いま調べている相手へ揃える**(#681 の着地前レビュー F2)。
     * ⚠ 直す前は静的な字だったので、取り込んだ `.sqlite` を選んでも
     *   「調べられるのは entries …」のままで、**そのとおり打つと英語で断られた**。
     */
    this.paintEngine(state);
    const target = p.guest === null ? null : { name: p.guest.name, tables: p.guest.tables };
    /**
     * 🔴 **案内も手本も約束も、いま引く engine へ揃える**(#682 段②)。
     * ⚠ `SQL_RULES` は**同梱の sqlite を実測した字**なので、DuckDB のまま出すと嘘になる
     *   (「REGEXP は使えません」は DuckDB では誤り)。
     */
    const engine: SqlEngine = sqlEngineOf(p);
    const tipText = sqlTipText(target, engine);
    if (this.tip !== null && this.tip.textContent !== tipText) this.tip.textContent = tipText;
    const rulesText = sqlRulesText(engine);
    if (this.rules !== null && this.rules.textContent !== rulesText) this.rules.textContent = rulesText;
    const hint = sqlPlaceholder(target, engine);
    if (this.box !== null && this.box.placeholder !== hint) this.box.placeholder = hint;
    // 🔴 **消えない手本も相手へ揃える**(#837 K1)── 薄字と同じ 1 本から採る
    const example = sqlExampleText(target, engine);
    if (this.example !== null && this.example.textContent !== example) {
      this.example.textContent = example;
    }
    if (!this.focused && !this.host.hidden) {
      this.focused = true;
      this.box?.focus();
    }
    /**
     * 🔴 **「答えの回」を数える必要は無い**(2026-09-09、変異試験 M27/M28 が SURVIVED で教えた)。
     *
     * ⚠ 初稿は「同じ字・同じ件数・同じ時間の 2 回目が素通りして、前の表が残る」と読み、
     *   state に連番(`runSeq`)を足した ── **外して壊れることを見ずに書いた**。
     * 🔑 実測すると壊れない:走らせると必ず `running: true` を通り、その版が**先に描かれる**
     *   ので、次に来る答えの指紋は**直前の指紋(走っています…)と必ず違う**。
     *   ⚠ だから連番は 1 度も効かない(**no-op**)。CLAUDE.md
     *   「『これが無いと壊れる』と書く前に、外して壊れるのを見る」。
     * ⚠ 振る舞いのほうは test が守っている(「同じ字をもう一度走らせると表が入れ替わる」)
     *   ── ここを直すときは、その test が落ちるかで確かめる。
     */
    const fingerprint = [
      p.ranSql,
      p.error,
      String(p.running),
      String(p.truncated),
      String(p.ms),
      String(p.rows.length),
      // ⚠ 書き出しの知らせも指紋に入れる ── 入れないと、答えが同じ回に**行が更新されない**
      p.saved,
      // ⚠ 調べる相手が変わったら、上の行を必ず言い直す(#681 段③ の 2 つ目)
      p.guest?.lid ?? '',
      p.guestError,
    ].join(' ');
    if (fingerprint === this.last) return;
    this.last = fingerprint;

    if (this.note !== null) {
      this.note.textContent = noteLine(p);
      // 🔑 断りの行だと分かる印(色は CSS 側が持つ)
      this.note.setAttribute('data-pkc-sql-error', p.error === '' ? 'no' : 'yes');
    }

    body.textContent = '';
    this.rows = p.rows;
    this.tbody = null;
    this.rowH = 0;
    this.drawn = null;
    if (p.columns.length === 0) return;
    const table = document.createElement('table');
    table.setAttribute('data-pkc-field', 'sql-table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of p.columns) {
      const th = document.createElement('th');
      th.textContent = c;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);
    body.append(table);
    this.table = table;
    this.head = hr;
    this.tbody = tbody;
    /**
     * 🔴 **まず 1 度描く ── ただし `SQL_WINDOW_MIN` 行までに留める**(#918 段③)。
     * 🔑 描かないと **1 行の高さ**も**列の幅**も測れない(CSS からは読めない)。
     *
     * 🔴 **ここで全部描いてはいけない**(自分の差分を読み直して見つけた)──
     *   測れるのは**画面に出ているときだけ**で、この面が `hidden` で常駐している
     *   間は `offsetHeight` が **0** を返す。全部描いてから測りに行く形にすると、
     *   **測れなかった回だけ 10 万行が DOM に残る**(いちばん重い場面で、
     *   いちばん効かない)。
     * 🔑 だから**先に上限を掛けてから**描く ── 測れなくても、残るのは
     *   「引っかかり 0 本」と実測した行数までである。
     */
    const total = p.rows.length;
    const seed = Math.min(total, SQL_WINDOW_MIN);
    this.paintRows({ from: 0, to: seed, above: 0, below: 0 });
    if (total <= SQL_WINDOW_MIN) return;
    this.measureAndPin();
    this.repaint();
  }

  /**
   * 🔴 **窓のぶんだけ `<tbody>` を描き直す**(#918 段③)。
   *
   * ⚠ 上下に空ける高さは **`<tr>` 1 本 + `<td colspan>`** で持つ ──
   *   `<tr>` に直接 `height` を当てても、升が 1 つも無い行は**潰れる**。
   * ⚠ 空け行には `aria-hidden` を付ける ── 読み上げに「空の行」を読ませない。
   */
  private paintRows(w: SqlWindow): void {
    const tbody = this.tbody;
    if (tbody === null) return;
    const cols = this.head?.childElementCount ?? 1;
    tbody.textContent = '';
    if (w.above > 0) tbody.append(spacerRow(cols, w.above));
    for (let i = w.from; i < w.to; i += 1) {
      const row = this.rows[i];
      if (row === undefined) continue;
      const tr = document.createElement('tr');
      for (const v of row) {
        const td = document.createElement('td');
        // ⚠ **字として入れる**(worker から来た値を HTML として注入しない)
        const text = cellText(v);
        td.textContent = text;
        /**
         * 🔴 **切られた字を読む道を残す**(#918 段③、着地前レビュー)。
         * ⚠ 窓に入ると列の幅を固定するので、**後ろの窓に長い値が出ると切られる**。
         *   直す前は `table-layout: auto` だったので表が広がって横に転がせた ──
         *   つまり**この PR で「読めなくなる」を作った**(CLAUDE.md §10)。
         * 🔑 だから升そのものに全文を持たせる(マウスを乗せると出る)。
         * ⚠ これでも触る端末では読めないので、**全部が要るなら
         *   「ノートへ」/「ファイルへ」**(どちらも全行・全文)である。
         */
        td.title = text;
        if (v === null) td.setAttribute('data-pkc-sql-null', 'yes');
        tr.append(td);
      }
      tbody.append(tr);
    }
    if (w.below > 0) tbody.append(spacerRow(cols, w.below));
    this.drawn = w;
  }

  /**
   * 🔴 **1 行の高さと列の幅を実測して、幅のほうは固定する**(#918 段③)。
   *
   * ⚠ **幅を固定しないと、転がすたびに列が動く** ── 表の幅は
   *   「いま描いてある行の中身」から決まるので、窓が入れ替わると幅も変わる。
   *   🔑 `CLAUDE.md §10`「置き換えられる側がついでに提供していた性質」の 1 つで、
   *   これは**こちらで置き直せる**(だから置き直す)。
   * ⚠ 測れない所(happy-dom は 0 を返す)では**何もしない** ── 当てると
   *   幅 0 の表になる(段②b の `fitSqlInput` と同じ作法)。
   */
  private measureAndPin(): void {
    const tbody = this.tbody;
    const table = this.table;
    const head = this.head;
    if (tbody === null || table === null || head === null) return;
    /**
     * ⚠ `tbody.rows` は**使わない** ── happy-dom が持っていないので、
     *   そこへ書くと **unit からこの段が 1 度も通れない**(実際に踏んだ)。
     * 🔑 ここは**空け行を作る前**に呼ばれるので、先頭の要素が必ず実データの行である。
     */
    const first = tbody.firstElementChild;
    this.rowH = first instanceof HTMLElement ? first.offsetHeight : 0;
    if (this.rowH <= 0) return;
    const widths = [...head.children].map((th) => (th as HTMLElement).offsetWidth);
    if (widths.some((n) => n <= 0)) return;
    for (const [i, th] of [...head.children].entries()) {
      (th as HTMLElement).style.width = `${String(widths[i] ?? 0)}px`;
    }
    table.style.tableLayout = 'fixed';
    /**
     * 🔴 **表そのものの幅も決める**(#918 段③。実ブラウザが 3/3 で再現して分かった)。
     *
     * ⚠ **`table-layout: fixed` だけでは効かない** ── 表の `width` が `auto` のままだと、
     *   ブラウザは中身から幅を決め直す。実測(5000 行・列 4 が `i*2`):
     *   上端(4 桁「4000」まで)で **40px** → 下端(5 桁「10000」)で **47px** に**動いた**。
     * 🔑 測った幅の**合計**を表の幅に当てると、そこで初めて固定が効く。
     * ⚠ 器より広ければ横に転がる ── それは窓に入る前と同じ振る舞いである。
     */
    table.style.width = `${String(widths.reduce((a, b) => a + b, 0))}px`;
  }

  /**
   * いまの転がり位置から窓を出し直す。⚠ **変わっていなければ描かない**。
   *
   * 🔴 **測れていなければ、ここで測り直す** ── 面が `hidden` のうちに答えが
   *   届いた回は高さが 0 なので、**見えるようになった最初の転がり**で測る。
   *   ⚠ そこで測り直さないと、その答えは**最後まで窓に入らない**
   *   (指紋の門があるので `render()` はもう来ない)。
   */
  private repaint(): void {
    const body = this.body;
    if (body === null || this.tbody === null) return;
    if (this.rows.length <= SQL_WINDOW_MIN) return;
    if (this.rowH <= 0) this.measureAndPin();
    if (this.rowH <= 0) return;
    const w = sqlWindowOf(this.rows.length, this.rowH, body.scrollTop, body.clientHeight);
    const had = this.drawn;
    if (had !== null && had.from === w.from && had.to === w.to) return;
    this.paintRows(w);
  }
}

/** 上下に空ける 1 本。⚠ 升を 1 つ入れないと `<tr>` の高さは効かない。 */
function spacerRow(cols: number, px: number): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.setAttribute('aria-hidden', 'true');
  tr.setAttribute('data-pkc-field', 'sql-row-spacer');
  const td = document.createElement('td');
  td.colSpan = Math.max(1, cols);
  td.style.height = `${String(px)}px`;
  td.style.padding = '0';
  td.style.border = 'none';
  tr.append(td);
  return tr;
}

/**
 * 表の上に出す 1 行。⚠ **どの状態でも 1 行言う**(黙って終わらない)。
 *
 * 🔴 **数だけで終えない ── 次の一手まで言う**(2026-09-09 の動線レビュー)。
 * ⚠ 「500 行」「0 行」で止めると、マニュアルを開いていない人はそこで手が止まる。
 */
/**
 * 🔴 **打った行数に合わせて高さを合わせる**(#918 段②b。user 裁定 2026-09-14)。
 *
 * 🔑 **下限と上限は CSS が持つ**(`min-height: 5em` / `max-height: min(40vh, 22em)`)──
 *   ここは「中身の高さ」を当てるだけで、**縮める向きの判断を持たない**
 *   (選んでいただいた札は「伸びる」なので、いまより小さくはならない)。
 * ⚠ 一度 `auto` に戻してから測る ── `scrollHeight` は**いまの高さに引きずられる**ので、
 *   そうしないと**伸びる一方**になって二度と戻らない。
 * ⚠ **測れない所では触らない** ── happy-dom は `scrollHeight` に **0** を返すので、
 *   そのまま当てると**欄が消える**(CLAUDE.md §2「本命の分岐を unit は通らない」の裏返しで、
 *   ここは**unit が通る側で壊れる**)。
 *
 * @returns 実際に付いた高さ(px)。⚠ 手で動かしたかの見分けに使うので、
 *   **上限で切られた後の値**を返す(当てた値ではない)。
 */
/**
 * 🔴 **色分けと行番号の層を塗る**(#918 段②c/②d)。
 *
 * 🔑 **升 1 つ = 論理行 1 本。** 番号は升の先頭に置くので、折り返して背が高くなっても
 *   番号は上端に揃う(行の高さぶんずつ積む形は、折り返した瞬間にずれる)。
 * ⚠ 中身は `sqlLineHtml` が返す**色付け済みの HTML** ── 素の字は escape 済みで、
 *   出てくる印は `<span class="pkc-tok-…">` だけである(`code-highlight.ts`)。
 * ⚠ **番号は `<span>` に入れて、字の列とは別の升にする** ── 同じ升へ字で足すと、
 *   選んで写したときに**番号まで一緒に写る**。
 */
export function paintSqlLayer(layer: HTMLElement, text: string): void {
  const lines = sqlLineHtml(text);
  const doc = layer.ownerDocument;
  layer.replaceChildren();
  for (let i = 0; i < lines.length; i++) {
    const no = doc.createElement('span');
    no.setAttribute('data-pkc-field', 'sql-line-no');
    no.textContent = String(i + 1);
    const code = doc.createElement('span');
    code.setAttribute('data-pkc-field', 'sql-line-code');
    // ⚠ 空の行にも高さが要る(升が潰れると番号がずれる)
    code.innerHTML = lines[i] === '' ? '&#8203;' : lines[i]!;
    layer.append(no, code);
  }
}

export function fitSqlInput(ta: HTMLTextAreaElement): number {
  ta.style.height = 'auto';
  const want = ta.scrollHeight;
  if (want <= 0) {
    ta.style.height = '';
    return 0;
  }
  /**
   * 🔴 **枠のぶんを足す**(2026-09-14 に実ブラウザの実測で判明)。
   *
   * ⚠ `scrollHeight` は**中身 + 内側の余白**で、**枠を含まない**。ところが欄は
   *   `box-sizing: border-box` なので、その値をそのまま `height` に当てると
   *   **枠のぶん(上下 1px ずつ)が中に食い込み、常に 2px 足りない**。
   * 🔑 実測:`scrollHeight 141` に対し `clientHeight 139` ── **欄が 2px 転がる**
   *   状態になっていた(段②b `7a92990` から在った。当時は気づけなかった)。
   *
   * ⚠ **枠の太さを直に読む** ── 数を書くと、枠を変えた日に片方だけ古くなる(§7)。
   * ⚠ **`offsetHeight - clientHeight` では採らない** ── あれは**横の転がし棒**も
   *   含むので、出た日に高さが増え、次の回でまた増える**伸びる一方の輪**になる。
   *   ⚠ しかも happy-dom は `clientHeight` に 0 を返すので、差が**高さ全部**になる
   *   (1 稿目はそれで unit が 3 件落ちた)。
   * ⚠ **`content-box` のときは足さない** ── そこでは枠は中に食い込まない。
   */
  const cs = ta.ownerDocument.defaultView?.getComputedStyle(ta);
  const frame =
    cs !== undefined && cs.boxSizing === 'border-box'
      ? (Number.parseFloat(cs.borderTopWidth) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0)
      : 0;
  ta.style.height = `${String(want + frame)}px`;
  return ta.offsetHeight;
}

/**
 * 🔴 **いま何番目を見ているか**(#918 段②a。user 裁定 2026-09-14)。
 *
 * ⚠ 何も起きていないときは**空**を返す ── 空なら呼び側が行ごと畳む
 *   (常に出すと、`↑` を 1 度も押していない人の画面に意味の無い行が残る)。
 * 🔑 **端に着いたことを字で言う** ── 直す前は、いちばん古い所まで来ても
 *   画面が 1 バイトも動かず、「これ以上前が無い」のか「鍵が効いていない」のか
 *   区別が付かなかった。
 */
export function historyNoteLine(p: AppState['sqlPage']): string {
  const n = p.history.length;
  if (n === 0) return '';
  if (p.historyAt < 0) {
    // ⚠ 控えが空 = まだ 1 度も遡っていない(戻ってきた人にだけ言う)
    return p.historyDraft === '' ? '' : '打ちかけの字を見ています';
  }
  const at = `前に打った字(${String(p.historyAt + 1)} / ${String(n)})`;
  return p.historyAt === n - 1 ? `${at} ── これより前はありません` : at;
}

function noteLine(p: AppState['sqlPage']): string {
  /**
   * 🔴 **どちらを調べているかは、どの行にも添える**(#681 の着地前レビュー F2)。
   * ⚠ 直す前は「まだ走らせていない」と「答えが出た」の 2 つにしか出ておらず、
   *   **断りが出た回と書き出した回で名札が消えていた** ── いちばん取り違えやすい
   *   のは断りの直後である。
   */
  /**
   * 🔴 **打ち切ったことは、選んでいる間ずっと言う**(#854 段①)。
   * ⚠ 黙って一部だけ返すと user は「これで全部」と読む ── いちばん気づけない
   *   外し方(CLAUDE.md §4)。だから**この相手を選んでいる限り毎行に添える**
   *   (答えが出た後・断られた後でも消えない)。
   */
  const truncNote =
    p.guest !== null && p.guest.truncated ? '(行が多いので、先頭だけを表にしています)' : '';
  const where = p.guest === null ? '' : ` ── ${p.guest.name} を調べています${truncNote}`;
  /**
   * 🔴 **開けなかったことを、いちばん上で言う**(#681 段③ の 2 つ目)。
   * ⚠ 黙って「この PKC」へ戻ると、選んだ人には**選べなかった**ようにしか見えない。
   * ⚠ **`.sqlite` に決め打たない**(#854 段①)── `.csv` / `.tsv` も同じ相手選びから
   *   開くので、字を見て相手を勘違いさせない。
   */
  if (p.guestError !== '') return `選んだ file を開けませんでした ── ${p.guestError}`;
  if (p.running) return `走らせています…${where}`;
  if (p.error !== '') return `${p.error}${where}`;
  /**
   * 🔴 **書き出したことを、いちばん上で言う**(#681 段③ の 3 つ目)。
   * ⚠ この面は**別の窓**なので、ノートを作っても窓の中は何も変わらない ──
   *   言わないと「押せなかった」に見える。
   */
  if (p.saved !== '')
    return p.savedKind === 'file'
      ? // ⚠ **落ちた先は言えない** ── ブラウザの設定(既定の保存先 / 毎回聞く)で変わる
        `「${p.saved}」という file に書き出しました(ブラウザの保存先をご覧ください)${where}`
      : `「${p.saved}」というノートに書き出しました(左の一覧に出ています)${where}`;
  /**
   * 🔴 **どちらを調べているかを、打つ前から言う**(#681 段③ の 2 つ目)。
   * ⚠ 言わないと「ノートを数えたつもりで、よその DB を数えていた」に気づけない。
   */
  if (p.ranSql === '')
    return p.guest === null
      ? ''
      : `${p.guest.name} を調べています(表 ${String(p.guest.tables.length)} 個 / ${humanBytes(p.guest.bytes)})${truncNote}`;

  const took = `(${String(p.ms)} ミリ秒)`;
  if (p.truncated)
    return `${String(p.rows.length)} 行${took} ── 多すぎるので途中まで出しています(LIMIT や条件で絞ると全部見えます)${where}`;
  if (p.rows.length === 0)
    return `0 行${took} ── 条件に当たるものがありませんでした${zeroHint(p.ranSql)}${where}`;
  return `${String(p.rows.length)} 行${took}${windowNote(p.rows.length)}${where}`;
}

/**
 * 🔴 **「見えている分だけ描いている」を、画面に常に出す**(#918 段③、動線レビュー)。
 *
 * ⚠ 窓で描くと、ブラウザの「ページ内を探す」と「表を全部選んでコピー」が
 *   **見えている行にしか効かなくなる**。それを知らせているのは
 *   ①起動時に 1 度だけ出るお知らせ ②マニュアル ── **どちらも読んだ人にしか届かない**。
 * 🔴 帰結が重い:user は「**無い**」と読むが、実際は「**見えていないだけ**」である。
 *   SQL は「データが本当にどうなっているか」を確かめる道具なので、
 *   **在るデータを無いと結論させる**のは、迷わせるより悪い。
 * 🔑 だから**表の上の帯**(常に出ている所)に 1 文足す ── 新しい部品は増やさない。
 * ⚠ **代わりを同じ文に書く**(「ノートへ書き出す / ファイルへ書き出す」)── 落ちた動線を
 *   言いっぱなしにしない(CLAUDE.md「捨てるものの表には、代わりに何ができるかを書く」)。
 */
function windowNote(rows: number): string {
  if (rows <= SQL_WINDOW_MIN) return '';
  return ' ── 見えている分だけ描いています(全部を探す・写すには ノートへ書き出す / ファイルへ書き出す)';
}

/**
 * 🔴 **0 行のとき、いちばん多い外し方を名指しする**(2026-09-09 の動線レビュー、実測)。
 *
 * ⚠ 日本語入力のまま `LIKE '％請求％'` と打つと、門は通り(引用符の中は直さないのが
 *   正しい ── 探したい字そのものだから)、走り、**0 行**で返る。
 *   実測:同じ 1 件に対して半角 `'%請求%'` は **1 行**、全角 `'％請求％'` は **0 行**。
 * 🔑 失敗ではなく **0 行**として返るので、user は「そのノートは無い」と読む ──
 *   いちばん気づけない外し方である。だから**画面が名前で言う**。
 */
function zeroHint(sql: string): string {
  return /[％＿]/.test(sql)
    ? '(打った字に全角の ％ か ＿ が入っています ── LIKE の記号は半角の % と _ です)'
    : '';
}
