/**
 * 🔴 **「指さないと始められない操作」の全数仕分けを腐らせない**(#582 R1)。
 *
 * ## なぜ test が要るか
 *
 * `docs/development/operation-model-2026-08.md` §4 の推薦は §7 条件① に懸かっている ──
 * **点引数が過半なら床はパレットではなく右クリックへ倒す**。実測は **40 / 196 = 20%**
 * (2026-09-05)で過半ではないので推薦は立つが、⚠ **受け手は増える**
 * (2026-08-29 は同じ日に 181 → 183 へ動き、2026-09-05 に 196 になった)。
 *
 * 🔑 だから見張るのは 2 つ:
 *   ① **割り当て漏れが出たら落ちる**(新しい受け手を足した人に仕分けさせる)
 *   ② 🔴 **doc の数と食い違ったら落ちる** ── この doc は**同じ日に 181 が 2 か所で嘘に
 *      なった**。数を doc に書く以上、**doc を読んで突き合わせる**しかない
 *
 * ⚠ **件数だけを pin しても足りない**(§1 空振り)── 2 件を種別ごと入れ替えても
 *   件数は動かない。だから**名指しの錨**を別に置く。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { receivers as receiversRaw } from '../scripts/action-outlets.mjs';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { assign as assignRaw, classify as classifyRaw, counts as countsRaw } from '../scripts/action-scope-survey.mjs';

type Cls = 'P1' | 'P2' | 'E' | 'V' | 'N';
const receivers = receiversRaw as () => string[];
const classify = classifyRaw as () => Map<string, Cls>;
const counts = countsRaw as () => Record<Cls, number>;
const assign = assignRaw as (
  all: readonly string[],
  groups: readonly (readonly [string, readonly string[]])[],
) => Map<string, string>;

const DOC = 'docs/development/operation-model-2026-08.md';

/**
 * doc §7.1 の表から 5 つの数を読む。
 *
 * ⚠ **見つからなければ投げる** ── 「0 件だから一致」を作らない(§1)。
 * ⚠ 行の頭を種別の名前で留める(散文の中の数字に満たされないため)。
 */
function docCounts(): Record<Cls, number> {
  const text = readFileSync(DOC, 'utf-8');
  const at = text.indexOf('### 7.1');
  if (at < 0) throw new Error(`${DOC} に §7.1 が無い(doc の形が変わった)`);
  const seg = text.slice(at, text.indexOf('\n## ', at) < 0 ? text.length : text.indexOf('\n## ', at));
  const out = {} as Record<Cls, number>;
  for (const [key, label] of [
    ['P1', 'P1 真の点'],
    ['P2', 'P2 現在地で代替'],
    ['E', 'E 列挙'],
    ['V', 'V 値'],
    ['N', 'N 名詞'],
  ] as const) {
    const m = new RegExp(`^\\| \\*\\*${label}\\*\\* \\| \\*{0,2}(\\d+)`, 'm').exec(seg);
    if (m === null || m[1] === undefined) throw new Error(`§7.1 の表に「${label}」の行が無い`);
    out[key] = Number(m[1]);
  }
  return out;
}

describe('#582 R1 ── 受け手の引数の仕分け', () => {
  it('🔴 受け手を 1 つ残らず仕分けている(足したら落ちる)', () => {
    const map = classify();
    expect(map.size, '仕分けが受け手と揃っていない').toBe(receivers().length);
  });

  it('🔴 件数を等値で pin する(推薦の根拠そのもの)', () => {
    // ⚠ 2026-08-31: `open-manual-window`(#645)で N が 1 増えた
    // ⚠ 2026-09-02: スマホ用画面の `phone-page` / `phone-menu`(#632 段①)で N が 2 増えた
    //   ── どちらも押した所から何も要らない(行き先はボタンの属性 / 対象は選択中のノート)
    // ⚠ 2026-09-04: 付箋の `open-note-window`(#685 段②)で N が 1 増えた
    //   ── 対象は押した行(無ければ選択中)で、押した所から引数は要らない
    // ⚠ 2026-09-04: `insert-diagram` / `copy-chapter-md` / `copy-block-md` / `set-too-narrow-enabled` 等で N が 92 → 96、#676 の板の 3 受け手で 99、合流後の実測で 100(2026-09-05、#724 ③ ── 内訳の 1 件は数え直していない)
    // ⚠ 2026-09-05: 塊の移動の「元に戻す」`undo-move`(#684 段①)で N が 1 増えた
    //   ── 材料は state の `lastMove`、押した所から何も要らない(`undo-append` と同じ)
    // ⚠ 2026-09-05(#215): 行の右クリックからの整理 3 つ(`rename-entry-begin` / `move-to-folder` /
    //   `create-in-folder`)で P2 が 29 → 32 ── 押した行が無ければ `selectedLid` に効く
    // ⚠ 2026-09-05(#579): `copy-section-ref` で N が 101 → 102(`copy-chapter-md` と同じ仕分け ──
    //   行番号はメニューが運ぶので、押した所からは何も要らない)
    // ⚠ 2026-09-05(#633 段③): `stack-load`(対象は押した行 / 選択中 → P2)/ `stack-save`
    //   (押した所から何も要らない → N)で P2 32 → 33、N 102 → 103
        // ⚠ 2026-09-05(#633 段④): `stack-link-up` / `stack-link-down`(押した行が要る → P1)で P1 40 → 42
    // ⚠ 2026-09-05(#720): スキップリンク `skip-to`(行き先は閉じた選択肢 → E)で E が 1 増えた
    // ⚠ 2026-09-05(#708 段②): 表の形を変える `table-to-markdown` / `table-to-csv` で N が
    //   103 → 105 ── 行番号はメニューが運ぶので、押した所からは何も要らない
    //   (`copy-chapter-md` / `copy-section-ref` と同じ仕分け)
    // ⚠ 2026-09-08(#722): 本文の置き場所(`set-prose-align`)で E が 20 → 21
    //   ── 紙面(`set-page-format`)と**同じ仕分け**(閉じた選択肢を 1 つ選ぶ)
    // ⚠ 2026-09-09(#679): まとめて貼る(`paste-many-copied`)で N が 108 → 109
    //   ── 選ぶのはダイアログの中なので、押した所からは何も要らない
    // ⚠ 2026-09-09(#818): 書庫の中を見る(`browse-archive`)で P1 が 42 → 43
    //   ── **押した添付の key が要る**(`download-asset` / `view-asset` と同じ仕分け)
    // ⚠ 2026-09-09(#681 段②): `set-sql-text` で V が 8 → 9(**打った字そのもの**)、
    //   `run-sql` で N が 109 → 110(押すだけ ── 何を走らせるかは state に在る)
    // ⚠ 2026-09-09(#681 段③): 答えをノートへ(`sql-to-note`)で N が 110 → 111
    //   ── 押すだけ(何を書き出すかは state に在る。`run-sql` と同じ仕分け)
    // ⚠ 2026-09-09(#681 段③): 調べる相手(`set-sql-source`)で V が 9 → 10
    //   ── **欄の値そのもの**(`<select>` が持つ lid)。⚠ E ではない:
    //   選択肢は**その人の添付**なので、閉じた一覧ではない
    // ⚠ 2026-09-09(#278 段②): `set-phone-links` で N が 1 増えた
    //   ── checkbox の `checked` を渡すだけなので、押した所からは何も要らない
    // ⚠ 2026-09-09(#683 段①): 録ったものを鳴らす(`capture-play`)で P1 が 43 → 44
    //   ── **押した 1 行**が要る(並んでいる兄弟のどれかで、state に「いまのそれ」は無い)。
    //   やめる(`capture-stop`)は N が 112 → 113 ── 鳴っているのは 1 件だけなので引数が要らない
    // ⚠ 2026-09-09(#809-4): 知らせの隣の「開く」(`swap-open`)で P2 が 33 → 34
    //   ── 点(`data-pkc-entry`)を取るが、その値は **state に在る**(`noticeOpen`)。
    //   ⚠ P1 ではない:画面に**その 1 つしか出ない**(兄弟の中から選ぶ操作ではない)
    // ⚠ 2026-09-09(#813): 「居場所」のプルダウンを外して `move-entry` の受け手ごと
    //   消えたので P2 が 34 → 33(残る口は `move-to-folder` と D&D)
    // ⚠ 2026-09-11(#215 残り①): 最近開いた記録を消す(`clear-opened-history`)で
    //   N が 113 → 114 ── 押すだけ(消す相手は端末ごとの記録 1 本しかない)
    // ⚠ 2026-09-12(#770 段②): タイルの目印を絵から選ぶ(`pick-app-icon`)で E が 22 → 23
    //   ── **閉じた選択肢を 1 つ**(`TILE_ICON_CHOICES` の 49 個 + 「なし」)。
    //   ⚠ V ではない:欄に打つ `set-app-icon` と違い、**打つ字が無い**(押すだけ)。
    //   ⚠ P1 でもない:並んでいる兄弟は**画面の物**ではなく**値**である。
    // ⚠ 2026-09-12(#857 段①): タイルを 1 つ動かす(`move-tile-up` / `move-tile-down`)で
    //   P1 が 44 → 46 ── **押した 1 枚**が要る(並んでいる兄弟のどれか)。
    //   ⚠ P2 ではない:行の「上へ / 下へ」(`move-order-up`)は帯が選択中の行に効くが、
    //   **タイルは右クリックしても選択が動かない**ので、state に「いまのそれ」は無い。
    // ⚠ 2026-09-13(#857 段①b-2): 並べ替えモードの出入り(`start-tile-reorder` /
    //   `end-tile-reorder`)で N が 114 → 116 ── **押した所から何も要らない**。
    //   ⚠ P1 ではない:入口は右クリックなのでタイルの上に出るが、印を付けるためだけに
    //   読んでおり、**名前だけでも呼べる**(モードは一覧ぜんたいの状態である)。
    // ⚠ 2026-09-13(#855 段 0 の 3 つ目): 札の繰り返し(`open-repeat-menu` /
    //   `set-task-repeat`)で P1 が 46 → 48 ── **押した 1 枚の札**が要る
    //   (行番号は札の中の印に在り、state には「いまのその行」が無い)。
    //   ⚠ E ではない:2 段目は閉じた選択肢に見えるが、**どの行に当てるか**は
    //   押した札からしか決まらない(`set-app-icon` が V なのは対象が selectedLid だから)。
    // ⚠ 2026-09-13(#857 段④): グループを畳む(`toggle-app-group`)で P1 が 48 → 49
    //   ── **押した見出し 1 つ**が要る(並んでいる兄弟のどれか)。
    //   ⚠ E ではない:選択肢は**画面に在る群**であって、閉じた値の一覧ではない
    //   (user がグループ名を打てば増える)。
    // ⚠ 2026-09-13(#857 段④の仕上げ): すべて畳む / すべて開く
    //   (`toggle-all-app-groups`)で N が 116 → 117 ── **押した所から何も要らない**。
    //   ⚠ P1 ではない:名前は押したボタンではなく**一覧に並んでいる見出し**から採る
    //   (「すべて」= いま画面に出ている群、という意味なので数え直す口を作らない)。
    // ⚠ 2026-09-13(#857 段②): グループの目印を選ぶ(`pick-app-group-icon`)で
    //   P1 が 49 → 50 ── **押した見出し 1 つ**が要る(並んでいる兄弟のどれか)。
    //   ⚠ N ではない:右クリックのメニューから撃つので押し所はメニューの中だが、
    //   **どの群に効くかは押した見出しからしか決まらない**(`carry` で写している)。
    // ⚠ 2026-09-13(#857 段③): グループの「上へ / 下へ」(`move-app-group-up` /
    //   `-down`)で P1 が 50 → 52 ── **押した見出し 1 つ**が要る。
    //   ⚠ P2 ではない:タイルの「上へ / 下へ」と同じで、**見出しを押しても選択は動かない**
    //   ので、state に「いまのその群」は無い。
    /**
     * ⚠ 2026-09-13(#856 段②): `adopt-link-icon` で **N が 1 増えた**。
     *
     * 🔴 1 稿目は押した器から飛び先を読んでいたので **P2** に入れていたが、
     *   `tests/action-outlets.test.ts` の `OBJECT_LONE`(対象が要るのに出口が
     *   1 か所)に落ちたので、**state から引く形へ直した** ── いまは押した所から
     *   何も要らないので **N**(名前だけで呼べる)である。
     * 🔑 つまりこの 1 件は、門が **#582 の向き(名前で呼べる側)へ押し戻した**形である。
     */
    /**
     * ⚠ 2026-09-13(#853 段①): `insert-icon` で **N が 1 増えた**(119 → 120)。
     *
     * 🔑 **N である** ── 押した所から何も要らない(挿す先は「いま打っている欄」で、
     *   `formatTarget(root)` が引く)。日付 / 雛形 / 図の一覧と同じ側である。
     */
    /**
     * ⚠ 2026-09-13(#884 段①): `set-app-open-target` で **N が 1 増えた**(120 → 121)。
     *
     * 🔑 **N である** ── 押した所から何も要らない(欄の値は `<select>` 自身から読む)。
     *   ⚠ **V ではない**:V は「欄の値そのものが対象を決める」形(絞り込みの条件 /
     *   添付の名前)で、こちらは**閉じた 2 択**である ── 同じ受け方の `set-open-place` が
     *   N に居るので、そちらと揃える(同じ形を 2 つの種別に割らない)。
     */
    /**
     * ⚠ 2026-09-13(#884 段②): `open-tile-as` で **P1 が 1 増えた**(52 → 53)。
     *
     * 🔑 **P1 である** ── `move-tile-up` / `move-tile-down` と**同じ右クリックの
     *   メニュー**(`tileMenuActions`)から出て、**同じ `carry`**(`data-pkc-tile`)で
     *   身元を写す。⚠ **N ではない**:右クリックしても選択(`selectedLid` /
     *   `launcherPick`)は動かないので、state に「いまのそのタイル」は無い ──
     *   `move-tile-up` が P1 なのと同じ理由で、押した器(メニューのボタン)からしか
     *   どのタイルかが決まらない。
     */
    // ⚠ 2026-09-14(#530 案 A): 板の形 5 つ(`place-shape-*`)で `N` が +5。
    //   ⚠ **`P1` ではない** ── 板の右クリックの中にしか押し口が無いので
    //   「兄弟のうち押した 1 つ」を取る形ではなく、`raise-place` / `remove-place`
    //   と同じ扱いにした(仕分けの表 `scripts/action-scope-survey.mjs` を揃えている)。
    /**
     * ⚠ 2026-09-14(#683 段②a): 録った音の前後を削る 4 つ(`capture-trim-*`)で
     *   **`N` が +4**(126 → 130)。
     *
     * 🔑 **`N` である** ── 押した所から**対象を取らない**:鳴っているのは
     *   常に 1 件(`capturePlayingLid`)なので、印も切り出しもその 1 件に効く。
     *   ⚠ **`P1` ではない**:「兄弟のうち押した 1 つ」を指す形ではない
     *   (`capture-trim-start` が押した行から読むのは**時刻の器**であって、対象ではない)。
     *   ⚠ **`P2` でもない**:P2 は `selectedLid` で代替する形だが、こちらは
     *   選択とは無関係の `capturePlayingLid` で決まる。
     */
    /**
     * ⚠ 2026-09-14(#918 段②a): 履歴の一覧(`sql-history-menu` / `sql-history-pick`)で
     *   **`P1` が +1(53 → 54)、`N` が +1(132 → 133)**。
     *
     * 🔑 **`sql-history-pick` は `P1`** ── 並んだ兄弟(前に打った字の一覧)のうち
     *   **押した 1 つ**でどれかが決まる。⚠ `N` ではない:一覧を開いても選択も
     *   `historyAt` も動かないので、state に「いまのその 1 件」は無い
     *   (`pick-app-group-icon` が `P1` なのと同じ理由 ── `attrs` で身元を写している)。
     * 🔑 **`sql-history-menu` は `N`** ── 押した所から**対象を取らない**
     *   (`target` は**どこに出すか**を測るためだけに読む)。
     */
    /**
     * ⚠ 2026-09-14(#918 段④): 答えを file へ(`sql-export-menu` / `sql-export-pick`)で
     *   **`E` が +1(23 → 24)、`N` が +1(133 → 134)**。
     *
     * 🔑 **`sql-export-pick` は `E`** ── 選ぶのは**閉じた 3 つ**(csv / tsv / json)で、
     *   一覧は `SQL_EXPORT_KINDS` に固定されている(`set-page-format` / `pick-app-icon` と同じ側)。
     *   ⚠ **`P1` ではない**:同じ「メニューから選ぶ」形でも、`sql-history-pick` は
     *   **並んだ物が user の打った字**なので押した 1 つでしか決まらない ── こちらは
     *   **値ごとに 1 行**をパレットへ出せる。
     * 🔑 **`sql-export-menu` は `N`**(`sql-history-menu` と同じ ── `target` は
     *   **どこに出すか**を測るためだけに読む)。
     */
    /**
     * ⚠ 2026-09-15(#682 段②): どのエンジンで引くか(`set-sql-engine`)で **`E` が 24 → 25**。
     * 🔑 **`E` である** ── 選択肢は `sqlite` / `duckdb` の **2 つで閉じている**
     *   (`SQL_ENGINE_LABEL` が正本)。⚠ **`V` ではない**:すぐ隣の `set-sql-source` が
     *   `V` なのは、並ぶ物が**その人の添付**で閉じていないからである ── ここは逆。
     */
    // ⚠ 2026-09-16(#918 段⑤d-1): 「繋ぐ」モードで P1 +1(`sql-er-unlink`。
    //   自分で引いた線の札は**押した 1 つ**でしか対象が決まらない ── `sql-er-link`
    //   と同じ仕分け)、N +1(`sql-er-connect-toggle`。入切そのものは対象を取らない)。
    // ⚠ 2026-09-16(#971 段③): N +2(`db-check` / `db-rescue`。
    //   壊れを調べる・拾い出すは、押した所から**何も要らない**)。
    // ⚠ 2026-09-16(#986 壊れても戻せる): N +1(`db-rescue-archive`。
    //   拾って戻せる形で書き出すのも、押した所から**何も要らない**)。
    // ⚠ 2026-09-17(#986 段③): N +1(`container-reset`。入れ物ごと捨てるのも、
    //   押した所から**何も要らない** ── 効く先はいまの `cid` で決まる)。
    // ⚠ 2026-09-18(#1006): N +1(`container-rebuild`。拾って作り直すのも、
    //   押した所から**何も要らない** ── 効く先はいまの `cid` で決まる)。
    // ⚠ 2026-09-20(#1017 段⓪): P1 +1(`system-jump`。「システム」の目次から
    //   節へ飛ぶ ── 同時に見えている兄弟(目次の行)のうち押した 1 つで決まる。
    //   `toc-jump` と同じ仕分け)。
    // ⚠ 2026-09-21(設計 doc §7、段②a): N +3(`open-messages` / `set-message-cap` /
    //   `export-messages`。メッセージを開く・保管件数を選ぶ・書き出すのも、
    //   押した所から**何も要らない** ── 効く先は固定の lid で決まる)。
    // ⚠ 2026-09-21(#1017 段④b): N −2 + 1(`db-rescue-archive` / `db-rescue` を
    //   退役させ、`toggle-plan-apply` を足した ── どちらも押した所から
    //   何も要らない N のまま、net で N −1)。
    // ⚠ 2026-09-21(#1017 段③-1): N +1(`toggle-container-repair`。退役させた
    //   「壊れて直らないときの、最後の手」の 2 ボタンを畳んだ箱に変え、その
    //   開閉ボタンを足した ── 押した所から**何も要らない**)。
    // ⚠ 2026-09-21(#1017 段③-2): N +1(`open-system-notices`。ヘルプの
    //   「お知らせを開く」── 行き先は固定で、押した所から**何も要らない**)。
    // ⚠ 2026-09-26(#1044 段2): P1 +1(`edit-section`。押した見出しの行が要る ──
    //   `edit-from-heading` と同じ仕分け)/ N +2(`save-section-draft` /
    //   `cancel-section-draft`。どちらも押した所から何も要らない ── 効く先は
    //   いま開いている章の下書きで決まる)。
    // ⚠ 2026-09-26(#1044 段3): P1 +1(`edit-code-block`。押した枠 1 つが要る ──
    //   `edit-section` と同じ仕分け)/ N +2(`save-code-draft` / `cancel-code-draft`。
    //   どちらも押した所から何も要らない ── 効く先はいま開いているコードの下書きで決まる)。
    // ⚠ 2026-09-27(#1044 段4): P1 +1(`open-chapter-window`。押した見出しの行が要る ──
    //   `edit-section` と同じ仕分け)。
    // ⚠ 2026-09-28(#1108): N +1(`sort-tasks`。完了項目を末尾へ寄せる ── `renumber-lists` と同じ仕分け)。
    // ⚠ 2026-09-28(#1107): N +1(`open-recent`。最近開いたノートの一覧を出す ── 押した所から何も要らない)。
    // ⚠ 2026-09-28(#1099): N +1(`close-lightbox`。ライトボックスを閉じる ── 押した所から何も要らない)。
    // ⚠ 2026-09-29(#1139): P1 +1(`toggle-code-collapse`。押したコード枠 1 つが要る ── `toggle-heading-fold` と同じ仕分け)。
    // ⚠ 2026-10-01(#1173): N +2(`task-run-open` / `task-run-done`。右クリックしたチェックリストの
    //   行番号はメニューが運ぶので、押した所からは何も要らない ── `table-to-csv` と同じ仕分け)。
    // ⚠ 2026-10-01(#1170): P1 +1(`jump-to-asset-use`。右の列の「添付」の行 ── 同時に見えている
    //   兄弟(行)のうち押した 1 つの key が要る。`toc-jump` と同じ仕分け)。
    // ⚠ 2026-10-01(#1172): N +1(`clear-search-history`。検索した語の記録を消す ── `clear-opened-history` と同じ仕分け)。
    // ⚠ 2026-09-30(#1169): P1 +1(`open-date-note`。押した日付 1 つが要る ──
    //   `toggle-code-collapse` と同じ仕分け)/ P2 +1(`create-date-note`。画面の下の口は
    //   1 つしか出ず、日付は state に在る ── `swap-open` と同じ仕分け)/ N +1
    //   (`set-date-links`。checkbox の値を渡すだけ ── `set-phone-links` と同じ仕分け)。
    // ⚠ 2026-10-01(#1225): N +1(`set-relative-days`。checkbox の `checked` を渡すだけ ── `set-date-links` と同じ仕分け)。
    // ⚠ 2026-10-01(#1174 段①): N +1(`set-missing-links`。checkbox の `checked` を渡すだけ ── `set-phone-links` と同じ仕分け)。
    // ⚠ 2026-10-01(#1010 B): N +1(`open-storage-check`。保存が止まった断り書きの隣から
    //   「システム」の保存領域の点検へ ── 行き先は固定で、押した所から**何も要らない**。
    //   `open-system-notices` と同じ仕分け)。
    // ⚠ 2026-10-01(#1087): N +2(`set-code-collapse` / `set-inline-code-copy`。checkbox の `checked` を渡すだけ ── 同じ仕分け)。
    // ⚠ 2026-10-01(#274 段①): P1 +1(`run-command-row`。左の列の探す欄に `>` を打つと出る操作の
    //   一覧の行 ── 同時に見えている行のうち押した 1 つの命令が要る。`toc-jump` と同じ仕分け)。
    // ⚠ 2026-10-01(#1102 段①): N +3(`search-jump-prev` / `search-jump-next` / `search-jump-end`。
    //   「探す」から送った本文の帯の押し所 ── 押した所から何も要らない。`clear-search-history` と同じ仕分け)。
    // ⚠ 2026-10-01(#813 段②): N +1(`toggle-filer-flatten`。フォルダの面の帯の入り切り ──
    //   押した所から何も要らない。`toggle-show-archived` と同じ仕分け)。
    // ⚠ 2026-10-01(#530 段③d): N +1(`remove-place-line`。右クリックした線の行番号はメニューが運ぶので、
    //   押した所からは何も要らない ── `remove-place` と同じ仕分け)。
    // ⚠ 2026-10-01(#918 段⑦): N +1(`remove-sql-source`。SQL の面で足した相手を外す口 ── 外す相手の lid は
    //   押し口自身が運ぶので、押した所からは何も要らない。`remove-place-line` と同じ仕分け)。
    // ⚠ 2026-10-02(#1224): N +1(`set-color-swatch`。checkbox の `checked` を渡すだけ ── `set-relative-days` と同じ仕分け)。
    // ⚠ 2026-10-02(#1224 段②): P1 +1(`pick-color`。押した見本の行・何番目・色が要る ── `edit-cell` と同じ仕分け)。
    // ⚠ 2026-10-02(#772 段②): P1 +1(`capture-transcribe`。「音/動画」の行の「文字にする」── 押した行が要る。
    //   `capture-play` と同じ仕分け)/ N +3(`install-asr-part` / `remove-asr-part` / `cancel-asr-install`。
    //   設定の「音声認識」の押し所 ── どの部品かは押したボタン自身が運ぶので、押した所からは何も要らない。
    //   `remove-sql-source` と同じ仕分け)。
    // ⚠ 2026-10-02(#215 段①②): N +3(`pc-pick-folder` / `pc-cut-folder` / `pc-more`。PC のタブの中の
    //   押し口 ── 押した所から何も要らない)/ P1 +1(`pc-open-file`。同時に見えている行のうち押した 1 つが要る。
    //   `toc-jump` と同じ仕分け)。
    // ⚠ 2026-10-02(#1264 §1): N +1(`pc-dir-note`。PC のタブのサブフォルダの行を押したときの返事 ── 押した所から何も要らない。
    //   `pc-more` と同じ仕分け)。
    // ⚠ 2026-10-02(#1264 §2): N +1(`pc-refresh-folder`。PC の帯の「更新」── 押した所から何も要らない。`pc-more` と同じ仕分け)。
    // ⚠ 2026-10-02(#1240): P1 +1(`edit-header-cell`。見出しの ✎ ── 押した見出しが要る。`edit-cell` と同じ仕分け)。
    // ⚠ 2026-10-02(#999): N +1(`storage-vacuum`。保存領域を縮める ── 押した所から何も要らない。`storage-profile` と同じ仕分け)。
    // ⚠ 2026-10-02(#275 段①): N +1(`set-pdf-reader`。checkbox の `checked` を渡すだけ ── `set-inline-code-copy` と同じ仕分け)。
    // ⚠ 2026-10-02(#1231 段①): E +1(`set-revision-compare`。履歴の差分の「くらべる相手」── 閉じた選択肢を 1 つ選ぶ。`set-prose-align` と同じ仕分け)。
    // ⚠ 2026-10-03(#530 段④): N +3(`place-color` / `place-color-clear` / `place-line-width`。付箋・線の右クリックの色と太さ ──
    //   押した所から運ぶのは札の名前と値だけで、対象の行はメニューが運ぶ刻印から引く。`raise-place` / `place-shape-*` と同じ仕分け)。
    // ⚠ 2026-10-04(#1232 段 b): P1 +1(`seek-media`。文字起こしの行頭の時刻 ── 押した時刻(ミリ秒)が要る。`open-date-note` と同じ仕分け)。
    // ⚠ 2026-10-07(#1407 段①): P1 +1(`revoke-agent`。設定の「ブラウザの AI に許したこと」の取り消し ── 押した行の範囲が要る。
    //   `revoke-extension` / `revoke-same-origin` と同じ仕分け)。
    // ⚠ 2026-10-11(#855 段 A-1): N +2(`schedule-mode` / `schedule-day-go`。予定の面の「一覧 / 日」と「日」の ‹ › 今日 ──
    //   押したボタン自身の属性(見せ方 / 行き先の日)を渡すだけ。`schedule-nav` と同じ仕分け)。
    // ⚠ 2026-10-10(#855 段 A-2): N +1(`schedule-week-pick`。「週」の曜日の見出し ── 行き先の日はボタン自身の属性で、押した所から他に何も要らない。
    //   `schedule-day-go` と同じ仕分け)。
    // ⚠ 2026-10-10(#1440): N +1(`export-entry-markdown`。右クリックの「Markdown で書き出す」── 押した行は `rowLidOrSelected` が決める。
    //   `export-entry-html` と同じ仕分け)。
    // ⚠ 2026-10-10(#1455 (b)): N +1(`export-markdown-folder`。右の列の「Markdown を PC のフォルダに書き出す」── `export-markdown` と同じ仕分け)。
    // ⚠ 2026-10-10(#1441): P1 +1(`toggle-log-day`。押した日の行が要る ── `toggle-heading-fold` と同じ仕分け)。
    expect(counts()).toEqual({ P1: 73, P2: 34, E: 26, V: 10, N: 186 });
  });

  it('🔴 名指しの錨 ── 件数が同じまま入れ替わっても落ちる', () => {
    const m = classify();
    // ⚠ 5 種それぞれの**代表**。どれも「なぜその種別か」が実装から読める物を選ぶ
    expect(m.get('edit-cell'), '表のセルは、どのセルを押したかが要る').toBe('P1');
    expect(m.get('select-entry'), '行の選択は selectedLid で代替できる').toBe('P2');
    expect(m.get('set-view'), '面の切替は閉じた選択肢').toBe('E');
    expect(m.get('set-app-icon'), 'アイコンは欄の値(対象は selectedLid)').toBe('V');
    expect(m.get('open-palette'), 'パレットを開くのに引数は要らない').toBe('N');
  });

  it('🔴 doc §7.1 の数と一致する(doc だけが古くなるのを止める)', () => {
    expect(docCounts()).toEqual(counts());
  });

  it('🔴 点引数は過半ではない(= 推薦「パレットが床」が立つ条件)', () => {
    const c = counts();
    const total = (Object.values(c) as number[]).reduce((a, b) => a + b, 0);
    expect(c.P1 * 2, `点引数が過半になった(${c.P1}/${total})── doc §7 条件①により推薦を見直す`)
      .toBeLessThan(total);
  });
});

/**
 * 🔴 **門そのものを叩く**(§2 未実行の経路)。
 *
 * ⚠ `classify()` は**正しい表**しか渡さないので、この 2 つの門は
 *   上の 5 件からは**一度も通らない** ── 消しても緑のままになる。
 */
describe('#582 R1 ── 仕分けの門', () => {
  it('🔴 実在しない受け手を割り当てたら投げる(綴り違いが静かに N へ落ちない)', () => {
    expect(() => assign(['a', 'b'], [['P1', ['a', 'typo-b']]])).toThrow(/実在しない受け手/);
  });

  it('🔴 同じ受け手を 2 度割り当てたら投げる', () => {
    expect(() => assign(['a'], [['P1', ['a']], ['E', ['a']]])).toThrow(/二重に割り当てた/);
  });

  it('⚠ 割り当てなかったものは N になる(対照群 ── 門が何でも投げるのではない)', () => {
    expect(assign(['a', 'b'], [['P1', ['a']]])).toEqual(new Map([['a', 'P1'], ['b', 'N']]));
  });
});
