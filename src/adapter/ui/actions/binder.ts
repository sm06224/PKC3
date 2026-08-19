/**
 * ActionBinder(PKC2 規約の維持): root での event delegation。
 * data-pkc-action を読んで UserAction を dispatch するだけ ── DOM は描かない。
 * action テーブルは登録制(編集系はここ、markdown ブロック系は P3-5 後半)。
 *
 * editor の本文は input delegation で都度 UPDATE_OPEN_BODY に写す(state が常に
 * 現在値を持つ ── dirty 判定・将来の autosave の土台)。1 打鍵 = 1 reduce は
 * openBody の spread のみで、描画側は編集中ガードで DOM を触らない。
 * 実測(run-editor-probe、15k 件・実 UI 経路): 小 body で打鍵 p50 ≈0ms、
 * 200KB body でも dispatch 有無の差は run 間ノイズに埋もれる(textarea 自体の
 * DOM コストが支配的)。⚠ 200KB 級では value 読取が打鍵ごとに O(body) の
 * string を作る ── GC churn が数字に出たら debounce / collect-at-commit へ
 * 切り替える(その時に計測してから)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { isViewMode, nextViewMode, type AppState, type ViewMode } from '@adapter/state/app-state';
import type { EntryMeta } from '@core/model/entry-meta';
import { filerRows, visibleSelection } from '@features/relation/filer-list';
import { archetypeLabel } from '@adapter/ui/render/sidebar';
import { ARCHETYPE_ICONS, setIcon } from '@adapter/ui/render/icons';
import { insertText } from '@adapter/ui/render/row-swap';
import { isImageAssetMime } from '@features/asset/asset-ref-format';
import { adoptableUrls, rewriteAdopted } from '@features/asset/inline-url-adopt';
import { convertPastedHtml } from '@features/markdown/html-to-markdown';
import { resolveMime } from './attach';
import { applyFormat, type FormatOp } from '@features/markdown/text-ops';
import { appendHeadingFor, isAppendable } from '@features/flavor/append-spec';
import { isEntrySort } from '@features/filter/entry-sort';
import { isPaneId, PANES } from '@features/pane-visibility';
import { STRUCTURAL, isRelationKind } from '@features/relation/kinds';
import { getAncestorFolders } from '@features/relation/tree';
import { planCopy } from '@features/relation/copy-plan';
import { otherSide, paneOf, paneScope, type DualSide } from '@features/relation/dual-pane';
import { appPanes, applyPaneVisibility } from '@adapter/ui/render/pane-visibility';
import { appKeymap, type KeymapStore } from '@adapter/ui/render/keymap';
import { appOpenInEdit, OpenInEditStore } from '@adapter/ui/render/open-in-edit';
import { chordOf, findCommand, typesCharacter } from '@features/keymap';
import { appQueryKey } from '@adapter/ui/render/query-key-store';
import { parseLinkTarget } from '@features/entry-ref/link-target';
import { handleCopyMdBlock } from './copy-md-block';
import { finishCopy, selectedMarkdown } from './copy-source';
import { copyMarkdownAndHtml, copyPlainText } from '@adapter/platform/clipboard';
import { cleanForClipboard } from '@features/export/clipboard-html';
import { askConfirm, SUPPRESSED_MESSAGE } from '@adapter/platform/ask-confirm';

type ActionHandler = (
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
  /** 束ねた root。⚠ **押したボタンから辿れない**ときに使う ── 追記は
   *  START_EDIT で detail を描き直すので、target は既に外れている */
  root: HTMLElement,
) => void;


/** 既定 title の種別ラベル(連番は同 archetype の現在数 + 1)。 */

/** lid: epoch(base36)+ セッション内単調 counter(PKC2 と同系の形式)。 */
let lidCounter = 0;
export function generateLid(): string {
  lidCounter += 1;
  return `${Date.now().toString(36)}-${lidCounter.toString(36).padStart(4, '0')}`;
}

/**
 * 🔴 **いまフォルダ面に出ている行**(着地前レビュー 2)。
 * ⚠ 規則は `filerRows` **1 か所**を通す ── 描く側(`render/filer.ts`)・
 * 範囲選択(reducer)・ここが別々に並びを組むと、**目で見たものと動くものが
 * 食い違う**(CLAUDE.md §7)。
 */
const visibleFilerRows = (st: AppState): EntryMeta[] =>
  filerRows(st.scopeLid, st.entryMetas, st.relations, {
    filterQuery: st.filterQuery,
    searchHits: st.searchHits,
    sort: st.entrySort,
  });

/** その entry が**既にそこに居る**か(動かす必要が無い)。 */
const alreadyThere = (st: AppState, lid: string, parentLid: string | null): boolean => {
  const parents = st.relations.filter((r) => r.kind === STRUCTURAL && r.toLid === lid);
  return parentLid === null
    ? parents.length === 0
    : parents.length === 1 && parents[0]?.fromLid === parentLid;
};

/**
 * 🔴 **居場所を変える唯一の実体**(着地前レビュー 7)。帯の `<select>` と
 * D&D が**別々に**書いていたので、断り方と「付いていく」の規則が経路で違った ──
 * 帯は phase を見ずに撃って reducer が黙って捨て(無言の操作拒否)、拒否されても
 * `SET_SCOPE` だけは撃つので**動いていないのに画面だけ移動**した。
 *
 * ⚠ **既にそこに居る**ものは失敗に数えない(着地前レビュー 6)── ルート直下の
 * 物をルートへ落としたとき「フォルダは自分の中へは入れられません」と出ていた。
 * 理由の違う断りを出すと、user は**入れ子の話だと読んで別のものを探す**。
 */
/**
 * 押した物から**どちらのペインか**を辿る(#241 段⑥-a)。
 * ⚠ state の `focus` から推測しない ── 焦点の無いほうを押したときに
 *   **反対側が動く**(押した所と効く所が違う、いちばん気づけない形)。
 */
const dualSide = (target: HTMLElement): DualSide | null => {
  const raw = target.closest('[data-pkc-side]')?.getAttribute('data-pkc-side');
  return raw === 'left' || raw === 'right' ? raw : null;
};

/** タブの添字。⚠ 数として読めないものは**捨てる**(0 に落とすと別のタブが閉じる)。 */
const dualTabIndex = (target: HTMLElement): number | null => {
  const raw = target.closest('[data-pkc-tab]')?.getAttribute('data-pkc-tab');
  // ⚠ **ここが唯一の関所ではない**(着地前レビュー M5)── 下流の `withTabClosed` /
  //    `withTabActive` にも `Number.isInteger` の門を置いてある。上流 1 行だけが
  //    守っている形にすると、その 1 行を消す変異が誰にも殺されない
  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
};

const moveEntries = (
  dispatcher: Dispatcher,
  lids: readonly string[],
  parentLid: string | null,
  report?: (text: string) => void,
): void => {
  if (lids.length === 0) return;
  if (dispatcher.getState().phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから動かしてください' });
    return;
  }
  let moved = 0;
  let same = 0;
  for (const lid of lids) {
    const st = dispatcher.getState();
    if (alreadyThere(st, lid, parentLid)) {
      same += 1;
      continue;
    }
    const before = st.relations;
    dispatcher.dispatch({ type: 'SET_ENTRY_PARENT', lid, parentLid, relationId: generateLid() });
    if (dispatcher.getState().relations !== before) moved += 1;
  }
  const refused = lids.length - moved - same;
  if (moved === 0 && same === 0) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'そこへは入れられません(フォルダは自分の中へは入れられません)',
    });
    return;
  }
  // ⚠ 一部だけ断られたときも**黙らない**(何件動いていないかを言う)
  if (refused > 0) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `${refused} 件は入れられませんでした(フォルダは自分の中へは入れられません)`,
    });
  }
  /**
   * 🔴 **画面は動かさない**(user 裁定 2026-08-18「**OS のファイラ動作に似せる方向で
   * 平仄も合わせて、日常の違和感が減る**」)。OS のファイラは、入れた先へ勝手に
   * 移動しない ── 入れたものが**いまの場所から消える**のが標準の見え方である。
   *
   * ⚠ ただし **PKC3 は行き先を名乗る** ── 「無言で終わらせない」を通してきたので、
   *   消えたのか入ったのかが分かる 1 行だけ残す(OS より一言多い)。
   * ⚠ 知らせは `OP_FAILED` に載せない(あれは**エラーの行**)── `showStatus` は
   *   `main.ts` の「一時の知らせ」へ出る。
   */
  const where =
    parentLid === null
      ? 'ルート'
      : (dispatcher.getState().entryMetas.get(parentLid)?.title ?? 'フォルダ');
  report?.(`${moved + same} 件を「${where}」へ入れました`);
};

/** UI サービス面(storage 依存の操作は main が実体を注入。test は fake)。 */
export interface BinderServices {
  attachFiles?(files: File[]): void;
  /**
   * 🔴 **スクショ(画像)の貼付**(#250。user 指示 2026-08-18
   * 「PKC3 でスクショ貼付の導線がない。PKC2 と同様以上に実装してください」)。
   *
   * 資産として置いて、**本文に差し込む参照(markdown)**を返す。
   * ⚠ **ノートは作らない** ── 編集中は `CREATE_ENTRY` が黙殺されるので、
   *   そこに乗せると bytes だけ残って参照が消える(`storeAsset` の注記)。
   * ⚠ 置けなかったものは**返さない**(呼び側が「落とした」と言えるように件数で分かる)。
   */
  pasteImages?(files: readonly File[]): Promise<readonly string[]>;
  /**
   * 🔴 **写す(コピー)のために本文をまとめて読む**(#273 段③)。
   * ⚠ **省略可** ── 無い環境(test の fake / 旧い配線)では「この版では写せません」と
   *   断るだけで、他は壊れない(落ち方は「機能が減る」側 ── `store-effects` と同じ規律)。
   * ⚠ 読めなかった lid は**返さない**(呼び側が件数で「落とした」と言える)。
   */
  readBodies?(lids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * 🔴 **飛んでいる書込が着くまで待つ**(#288)。
   *
   * ⚠ 書込は effect 層の chain に直列化されるが、**編集の開始はその外**に在る ──
   *   チェックの印を押した直後に「編集」へ入ると、入力欄には**押す前の本文**が出て、
   *   そこで 1 文字でも打つと可視内容の last-write-wins で**押した印が黙って戻る**。
   * 🔑 待つ口は既に在る(`connectStoreEffects().settled()` ── 書き出しが
   *   2026-08-17 に同じ穴で作ったもの)。**2 本目を作らない**。
   * ⚠ **省略可**(`undefined` / `null`)── 無い環境では今までどおり同期に始まる。
   */
  settle?(): Promise<void> | null;
  downloadAsset?(assetKey: string, name: string): void;
  /**
   * 🔴 **貼る用に画像を持ち歩ける形へ**(#193)。`blob:` → `data:` の対応を返す。
   * ⚠ **省略可** ── 無ければ画像は文字に置き換わる(壊れた画像を貼らせない)。
   */
  inlineImages?(urls: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * 🔴 **貼り付けた本文の `data:` / `blob:` を資産にする**(#251 の B + C)。
   * `url → asset:<key>` の対応を返す。⚠ **読めなかった url は入れない** ──
   * 呼び側が「元のまま残した」と件数で言えるようにする(黙って消さない)。
   * ⚠ **省略可** ── 無ければ本文はそのまま(貼付自体は成立する)。
   */
  /**
   * 🔴 **一時の知らせ**(「3 件を『はこ』へ入れました」)。⚠ エラー(`OP_FAILED`)とは
   * **別の行**である ── `main.ts` が優先順位(エラー > 知らせ > 常設)を持っているので、
   * 成功の一報を `OP_FAILED` に載せない(載せると赤い意味の欄に出る)。
   */
  showStatus?(text: string): void;
  adoptPastedUrls?(urls: readonly string[]): Promise<{
    readonly adopted: ReadonlyMap<string, string>;
    /** 置けなかった理由(空き容量など)。⚠ **呼び側が 1 本の文言に組み立てる**。 */
    readonly problems: readonly string[];
  }>;
  /**
   * 🔴 **添付を別の窓で見る**(#192 で画像、2026-08-15 に PDF を追加)。
   * ⚠ 実体は adapter/platform 側(ObjectURL の寿命が絡むので、binder は**呼ぶだけ**)。
   * ⚠ `mime` は**押した要素が運ぶ** ── 開く側で引き直さない。
   */
  viewAsset?(assetKey: string, name: string, mime: string): void;
  /** 未参照 asset の掃除(P4b)。確認・報告の UI も実体側の責務。 */
  purgeOrphanAssets?(): void;
  /** 注意の面を閉じる(P6c review H-2)。 */
  dismissNotices?(): void;
  /**
   * ランチャーのタイルを起動する(P7b 段⑩)。
   * ⚠ blob の貸し出し・`window.open` は実体側 ── binder は DOM を触らない。
   */
  openTile?(lid: string): void;
  /**
   * 🔴 **選んでいる添付を起動する**(P10、user 指示 2026-08-05
   * 「HTML アセットの詳細画面から起動できない」)。
   *
   * ⚠ タイル(`openTile`)とは**別**である ── あちらは「アプリとして登録」した
   * ものを lid で引くが、こちらは**登録の有無に依存しない**(開けることと
   * 一覧に並べることは別の話)。
   * ⚠ `sameOrigin` は詳細画面の別のボタンからのみ true になる。
   */
  launchAsset?(lid: string, opts: { sameOrigin: boolean }): void;
  /**
   * 🔴 **添付を Office の別窓で開く**(#88 / O3-c。user 裁定 2026-08-10)。
   *
   * ⚠ `launchAsset` とは**別**である ── あちらは HTML アプリを囲いの中で走らせる。
   * こちらは LibreOffice wasm の窓に文書を流し込む。
   * ⚠ **同期で呼ぶ**(実体側が `window.open` を user gesture の中で撃つ)。
   * ⚠ 引数は押したボタンの属性から採る ── lid から本文を読み直す暇が無い。
   */
  openOffice?(target: { name: string; mime: string; assetKey: string; lid: string }): void;
  /**
   * 🔴 **Office 一式(約 77MB)を入れる / 消す**(#88 / O6-a。user 裁定 2026-08-10
   * 「実行したい人が手動で設定した際に追加ダウンロードと idb とか opfs に配備して」)。
   *
   * ⚠ **勝手に取りに行かない** ── 押した人にだけ取らせる。
   * ⚠ `installOfficePackFromFile` は**配布元に届かない環境の唯一の道**なので、
   *   保険ではなく一級の導線として扱う(user 裁定「ローカルとかを介して」)。
   */
  installOfficePack?(): void;
  installOfficePackFromFile?(file: File): void;
  removeOfficePack?(): void;
  /** 配色を切り替える(P7b 段⑨c)。⚠ user の好みで、flag でも container でもない。 */
  setTheme?(theme: string): void;
  /**
   * 外部の画像を読み込むかの設定(2026-08-06、user 裁定)。
   * ⚠ 「常にオン / 常に確認 / 常にオフ」の 3 択。⚠ flag ではない(正規設定)。
   */
  setExternalImages?(mode: string): void;
  /**
   * 紙面(2026-08-08、user 裁定「A4 と A3、フル HD と 4:3 の縦横」)。
   * ⚠ **flag ではない**(正規設定)── 散文の読み幅と、印刷の紙が決まる。
   */
  setPageFormat?(format: string): void;
  /**
   * 編集の仕方(#104 第 2 弾。user 裁定 2026-08-08)。
   * ⚠ **flag ではない**(正規設定)── 効くのは次に編集を開いたとき。
   */
  setEditorMode?(mode: string): void;
  /**
   * 添付の携帯参照(`pkc://<自分>/asset/<key>`)から**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ 見つからないときは黙らない(OP_FAILED で断る ── 無言の dead click を作らない)。
   */
  navigateAssetRef?(assetKey: string): void;
  /**
   * 編集権を取る(#177 多重タブ ── 同じノートの 2 枚目編集を止める)。
   * false = 別のタブが編集中。⚠ 判断(台帳)は storage proxy 側が持つ。
   * ⚠ 解放の正本は main.ts の phase 遷移 watcher ── ここの release は
   *   「取ったのに編集に入れなかった」ときの返却だけ。
   */
  acquireEditLock?(lid: string): Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?(lid: string): void;
  /**
   * フラグの切替(P11。user 指示 2026-08-07)。
   * ⚠ **設定ではない** ── 開発者・パワーユーザー向けで、いつか畳まれる。
   */
  setFlag?(name: string, on: boolean): void;
  resetFlags?(): void;
  /**
   * いま開いているノートについて答えた(「常に確認」の帯の 2 つのボタン)。
   * ⚠ **ノート単位**で、覚えるのはタブを閉じるまで。⚠ 設定は変えない ──
   *   1 件の判断で全ノートの既定を動かさない。
   */
  answerExternalImages?(allow: boolean): void;
  /** 左の列の探し方(一覧 / フォルダ / アプリ)。⚠ 中央のビューとは別の軸(P8 段⑤)。 */
  setBrowse?(mode: string): void;
  /** 新しい版に交代する(P7 段⑤)。⚠ 交代を頼むだけ ── 再読込は交代後。 */
  applyUpdate?(): void;
  /**
   * 起動したときのお知らせ(P11 段⑤)。
   * ⚠ `dismiss` は**読んだことにする**(次から出ない)。`mute` は**今後出さない**
   *   ── 設定から戻せる(戻せない導線は作らない)。
   */
  dismissAnnounce?(): void;
  muteAnnounce?(): void;
  /**
   * お知らせを出すかの設定(P11 段⑤)。⚠ **flag ではない**(正規設定)──
   * 開放先は user で、畳む予定も無い。⚠ 帯の「今後は出さない」の**戻し道**である。
   */
  setNoticesEnabled?(on: boolean): void;
  /**
   * 「開く」で編集に入るか(user 裁定 2026-08-18)。⚠ **flag ではない**(正規設定)。
   * ⚠ 読む側は `services` ではなく `openInEdit` を引く(下の `bindActions` の引数)──
   *   ここは**書き手**だけ。
   */
  setOpenInEdit?(on: boolean): void;
  /** 更新の案内を見送る(次に開いたときに再び出る)。 */
  dismissUpdate?(): void;
  /** アーカイブ書出し(P6d)。 */
  exportArchive?(): void;
  /** 可搬 HTML の書出し(P6d 段③)。 */
  exportHtml?(): void;
  /** md ZIP の書出し(P6d 段④)。 */
  exportMarkdown?(): void;
  /** このノートを Word(.docx)で書き出す(#187 段①)。 */
  exportEntryDocx?(lid: string): void;
  /** このノートだけをアーカイブとして書き出す(P6f)。 */
  exportEntry?(lid: string): void;
  /**
   * 図 1 枚をベクタ(`.svg`)で書き出す(P8 段⑦)。
   * ⚠ 画面に置くのは PNG、書き出すのは SVG(user 指示 2026-08-03)。
   * @param index 同じ本文の中で**何枚目か**(0 始まり ── 名前は 1 始まりにする)
   */
  /** ⚠ **Promise を返す** ── 押した側が「終わった」を知らないと待ちを出せない。 */
  exportDiagram?(source: string, index: number): void | Promise<void>;
  /** 文字列をクリップボードへ(P8 段⑱)。⚠ 失敗も可視で終える。 */
  copyText?(text: string): void;
  /**
   * 添付 gate(書出し / 取込 / 整理)が実行中か。
   * ⚠ **破壊的操作を止めるために要る**(P6f review M-2)── 「書き出す」と「削除」を
   * 隣に並べた以上、走査中に消せてしまうと **user は書き出したつもりでファイルが
   * 1 個も落ちていない**状態になる。
   */
  busy?(): boolean;
  /**
   * 🔴 **開いた md を元ファイルへ書き戻す**(2026-08-05、user 報告
   * 「スポットの編集プレビュー導線も存在しない」)。
   * ⚠ 確認・許可・書込は実体側 ── binder は「押された」を伝えるだけ。
   */
  writeBackFile?(lid: string): void;
  /** PKC2 ファイルの取込(P6b)。判別・変換・書込は実体側の責務。 */
  /** 取込(PKC2 の書出し / 素の Markdown)。振り分けは import-file.ts が持つ。 */
  importFiles?(files: File[]): void;
}

function defaultTitle(dispatcher: Dispatcher, archetype: string): string {
  const label = archetypeLabel(archetype);
  let n = 0;
  for (const m of dispatcher.getState().entryMetas.values()) {
    if (m.archetype === archetype) n += 1;
  }
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date} ${label} ${n + 1}`;
}

/**
 * cancel 経路: fresh entry(作成直後)で title だけ入力されていた場合は、
 * title を RENAME で保存してから cancel する ── 「title を打って Esc」で
 * entry ごと消えて入力が失われる非対称の解消(P3-7a review 中)。
 * 非 fresh の cancel は破棄の意味論どおり title input も捨てる。
 */
function cancelFromEditor(dispatcher: Dispatcher, root: HTMLElement): void {
  const s = dispatcher.getState();
  const lid = s.openBody?.lid;
  if (lid && s.freshLid === lid) {
    const input = editorTitle(root);
    const current = s.entryMetas.get(lid)?.title ?? '';
    if (input && input.value.trim() !== '' && input.value.trim() !== current) {
      // RENAME が fresh を解除する ── 直後の CANCEL は entry を残す
      dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
    }
  }
  dispatcher.dispatch({ type: 'CANCEL_EDIT' });
}

/**
 * いま画面に出ている題名欄。
 *
 * 🔴 **root から引く**(P8 段⑲。押したボタンから `closest` で辿らない)。
 * 直す前は `from.closest('[data-pkc-region="detail"]')` だったが、
 * 追記欄(`append` region)の **保存して解放 / 編集を破棄** は detail の
 * **兄弟**なので `closest` が null を返し、題名欄が 1 度も見つからなかった
 * ── その出口から保存すると**題名の変更が丸ごと捨てられて**いた。
 * 同じ「保存」なのに押す場所で結果が違う、という壊れ方である。
 * ⚠ 入口は 1 つに寄せる(`editorBody` と同じ引き方)。
 */
function editorTitle(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-title"]',
  );
}

/** editor 表示中なら title input の現在値で RENAME を先行 dispatch する
 *  (楽観 meta 更新 → 直後の COMMIT_EDIT が新 title で行を組む。
 *  input が見つからなければ何もしない = 既存 title 維持 ── PKC2 の
 *  「title が消える」bug の防波堤と同じ向き)。 */
function renameFromEditorInput(dispatcher: Dispatcher, root: HTMLElement): void {
  const input = editorTitle(root);
  const lid = dispatcher.getState().openBody?.lid;
  if (input && lid)
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
}

/** いま画面に出ている編集欄(root にスコープする ── document 全域は他 root を拾う)。 */
function editorBody(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-body"]',
  );
}

/**
 * 🔴 **書式の効く先**(2026-08-08)。2 列なら `editor-body`、live の 1 面なら
 * **活性の行の入力欄**(`row-source`)── 直す前は live 面で書式パネルと
 * Ctrl+B/I/K が `editor-body` を探して**無言 no-op** だった(押しても何も
 * 起きず、理由もどこにも出ない)。
 * ⚠ 2 つは同時には存在しない(live ↔ 2 列は排他。live の退避は `editor-body`)。
 * ⚠ `writeBack` の `value` 直代入は行の中の Ctrl+Z を捨てる ── 行は Escape で
 * 丸ごと戻せるので、2 列の editor と同じ理由で受け入れる。
 */
function formatTarget(root: HTMLElement): HTMLTextAreaElement | null {
  return (
    root.querySelector<HTMLTextAreaElement>(
      '[data-pkc-region="detail"] [data-pkc-field="row-source"]',
    ) ?? editorBody(root)
  );
}

/** 読む面の描画済み本文(コピーの書式付き / 選択範囲が読む)。 */
function viewBodyHost(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[data-pkc-region="detail"] [data-pkc-field="detail-body"]',
  );
}

/**
 * 書き換えた本文を編集欄へ戻す。
 *
 * 🔴 **`input` を自分で撃つ**。ここで state へ直に `UPDATE_OPEN_BODY` を送ると、
 * 経路が 2 本になる(binder の delegation と、この関数)── 片方を壊しても
 * もう片方に救われて test が緑のまま通るので、**入口は 1 つに寄せる**。
 * プレビューも textarea の `input` で駆動しているので、これ 1 発で state と
 * 画面の両方が追いつく。
 *
 * ⚠ `value` の直代入はブラウザの取り消し履歴(Ctrl+Z)を捨てる。書式パネルは
 * 「保存 / キャンセル」で丸ごと戻せるので、ここでは受け入れる ── 取り消しを
 * 残すには `execCommand('insertText')` が要るが、経路が 2 本になる。
 */
function writeBack(
  ta: HTMLTextAreaElement,
  next: { text: string; start: number; end: number },
  toBottom = false,
): void {
  ta.value = next.text;
  ta.setSelectionRange(next.start, next.end);
  ta.focus();
  // 追記はカーソルが末尾 ── 見えていないと「押しても何も起きない」に見える
  if (toBottom) ta.scrollTop = ta.scrollHeight;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 🔴 **書出し / 取込の実行中は、本文を書き換えさせない**(P8 段㉑)。
 *
 * 直す前この判定は `delete-entry` **1 か所だけ**にあった。ところが書出しは
 * 本文を 4MB ずつページングし(`await` を跨ぐ)、そのあとで履歴の鎖を引く ──
 * バッチの隙間に保存が割り込むと、**同じノートの本文は旧版、鎖の頭は新 tip 基準**
 * という噛み合わないアーカイブができる。取り込み直すと検査が発火して
 * 「履歴が噛み合いません」だけが出て、そのノートの履歴が丸ごと落ちる
 * (title / status は検査が無いので**黙って**旧値が入る)。
 *
 * 「削除は止めるのに保存は止めない」= 同じ危険に対して入口ごとに答えが違う、
 * という状態だった。⚠ **規則は 1 本**にして、本文を書き換える入口すべてに掛ける。
 */
const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'start-edit',
  'commit-edit',
  'append-entry',
  'toggle-todo',
  'toggle-app-tile',
  'delete-entry',
  'restore-revision',
  'restore-trash',
  'purge-trash',
  // ⚠ 本文は書かないが **disk への書込**である(取込は relations を総入れ替えする
  //    ので、走っている最中に居場所を変えると片方が消える)
  'move-entry',
  // ⚠ user の**ファイル**を上書きする ── 取込・書出しの最中に走らせない
  'write-back-file',
]);

/**
 * 🔴 **確認が出ていないことを黙らせない**(2026-08-06。user 報告 minor)。
 *
 * ⚠ 抑止は**解除できない**(仕様)。ここがするのは理由を出すことだけ ──
 * 判定と文言は `platform/ask-confirm.ts` の 1 か所に置く(規則を 2 つ書かない)。
 * @param whenAbsent confirm が**無い**環境での既定(呼び側の倒し方を持ち込む)
 */
function confirmOrExplain(
  dispatcher: Dispatcher,
  message: string,
  whenAbsent: boolean,
): boolean {
  const r = askConfirm(message, { whenAbsent });
  if (r.suppressed) dispatcher.dispatch({ type: 'OP_FAILED', error: SUPPRESSED_MESSAGE });
  return r.ok;
}

function refuseWhileBusy(
  action: string,
  dispatcher: Dispatcher,
  services: BinderServices,
): boolean {
  if (!BODY_WRITE_ACTIONS.has(action) || services.busy?.() !== true) return false;
  // ⚠ **可視に断る**(無言の操作拒否を作らない)
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: '書き出し / 取込が実行中です。完了してから操作してください',
  });
  return true;
}

/** 並べ替えの 2 つの向きで同じことをする(規則を 2 か所に書かない)。 */
function moveOrder(
  dispatcher: Dispatcher,
  target: HTMLElement,
  direction: 'up' | 'down',
): void {
  const lid = target.getAttribute('data-pkc-entry');
  if (!lid) return;
  dispatcher.dispatch({ type: 'MOVE_ENTRY_ORDER', lid, direction });
}

/**
 * 本文のリンク(`entry:` / `@card`)から別のノートを開く。
 *
 * 🔴 **規則は 1 本**(`link-target.ts`)。⚠ 断る 3 つはどれも**可視に**返す ──
 * `SELECT_ENTRY` は編集中 / error / 未知 lid で**黙って何もしない**ので、
 * 素直に撃つと「押しても無言」が残る(直そうとしている当のものになる)。
 */
function navigateToLink(dispatcher: Dispatcher, raw: string | null): void {
  const t = parseLinkTarget(raw ?? '');
  if (t.kind === 'invalid') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'リンクの書き方が読めません' });
    return;
  }
  if (t.foreign) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'このリンクは別の PKC のノートを指しています',
    });
    return;
  }
  if (!selectEntryOrExplain(dispatcher, t.lid, 'リンク先')) return;
}

/**
 * 🔴 **ノートを開く。開けないときは理由を出す**(2026-08-08)。
 *
 * ⚠ `SELECT_ENTRY` は reducer が **編集中 / error / 未知 lid で黙って捨てる**
 * (`app-state.ts`)。素直に撃つと**押しても無言**になる ── この repo が
 * 繰り返し踏んできた形である。
 *
 * 🔑 **規則を 1 か所に寄せる**(CLAUDE.md「同じ判定が 2 か所に生えたら…」)──
 * 本文のリンク(`navigate-*`)も一覧の行(`select-entry`)も、
 * 「ノートを開きたい」という同じ意図であり、断る条件も同じである。
 *
 * ⚠ **開けるようにはしない。** 面の切替(設定 / フラグ / ヘルプ)は面が常駐する
 * ので開けるようにしたが(user 裁定 2026-08-08)、**別のノートへ移るのは下書きを
 * 捨てることになる** ── ここは止めるのが正しく、無言なのが間違いだった。
 *
 * @param what 断り文に入れる呼び名(「リンク先」/「ノート」)
 * @returns 開いたら true
 */
function selectEntryOrExplain(dispatcher: Dispatcher, lid: string, what: string): boolean {
  const state = dispatcher.getState();
  if (state.phase === 'editing') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `編集を終了してから${what}を開いてください`,
    });
    return false;
  }
  if (!state.entryMetas.has(lid)) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${what}のノートが見つかりません` });
    return false;
  }
  dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  return true;
}

/**
 * 🔴 **まとめてゴミ箱へ、の実体は 1 本**(#273 段②)。
 *
 * ⚠ 左の列と 2 ペインで**別々に書かない** ── 断り方・確認・「戻せます」の言い方が
 * 経路で食い違うと、user は同じ操作なのに違う説明を受ける(CLAUDE.md §7)。
 * 🔑 **相手の集合は呼び側が渡す** ── 「いまどの面を見ているか」で推測すると、
 * 2 ペインを開いたまま左の列のボタンを押したときに**画面に無いものが消える**。
 */
function deleteFrom(
  dispatcher: Dispatcher,
  services: BinderServices,
  rows: readonly EntryMeta[],
  selection: readonly string[],
): void {

    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから削除してください',
      });
      return;
    }
    if (refuseWhileBusy('delete-selected', dispatcher, services)) return;
    /**
     * 🔴 **見えている行に絞る**(着地前レビュー 2)。印は行が見えなくなっても
     * 残る(絞り込みで消えた / 別タブが消した)ので、素で消すと**画面に無いものが
     * ゴミ箱へ入る**。⚠ 帯に出す数(`filer.ts`)と**同じ規則**を通す ──
     * 食い違うと「2 件を削除しますか?」と聞いて 3 件消す形になる。
     */
    const lids = visibleSelection(rows, selection);
    if (lids.length === 0) {
      /**
       * ⚠ **無言で終わらせない** ── 帯は出ているのに何も起きない dead click になる。
       * 🔴 **印が 0 件のときも黙らない**(2026-08-18 の着地前レビュー 2)。
       * `Delete` の鍵から来る筋では、`Enter` でフォルダへ入った直後が
       * まさにこれ(`SET_SCOPE` が印を外すので `selection` は空)── 焦点の枠は
       * 行に見えているので、user は「選べているのに Delete が効かない」と読む。
       * ⚠ OS のファイラも「選んでいなければ何もしない」が、PKC3 は
       *   **理由を出す**側に倒す(この面の他の断りと揃える)。
       */
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          selection.length > 0
            ? '選んでいた行がいま画面にありません(絞り込みを消すか、選び直してください)'
            : '削除するものを選んでください(行を押すと選べます)',
      });
      return;
    }
    if (
      !confirmOrExplain(
        dispatcher,
        `選んでいる ${lids.length} 件を削除しますか?(ゴミ箱から戻せます)`,
        true,
      )
    )
      return;
    dispatcher.dispatch({ type: 'DELETE_ENTRIES', lids });
}

const ACTIONS: Record<string, ActionHandler> = {
  /**
   * 🔴 **本文のリンクで別のノートへ飛ぶ**(2026-08-08。user 裁定「任せます」)。
   *
   * markdown は `[題名](entry:<lid>)` と `@[card](entry:<lid>)` に
   * `data-pkc-action` を焼いていたのに、**受け手が 1 つも無かった** ──
   * 記法だけ移植して置き忘れた形で、押しても無言で何も起きなかった。
   *
   * ⚠ **無言で断らない**(`delete-entry` と同じ倒し方)。断る先は 3 つ:
   *  ① 編集中(下書きを守る。⚠ 面の切替とは別 ── あちらは開けるようにした)
   *  ② 解けないリンク(壊れた綴り)③ このアプリに無い / 別コンテナのノート
   * ⚠ **fragment は見ない** ── 飛び先の要素を出す実装が `src` に無い 4 形が
   *   あるので、いまは lid まで開く(`link-target.ts` に理由)。
   */
  'navigate-entry-ref': (dispatcher, target) => {
    navigateToLink(dispatcher, target.getAttribute('data-pkc-entry-ref'));
  },
  /**
   * `@[card](…)` の placeholder。⚠ **解決器は `entry:` と同じ 1 本**
   * (target は `entry:` か `pkc://<cid>/entry/<lid>` のどちらか)。
   */
  'navigate-card-ref': (dispatcher, target) => {
    navigateToLink(dispatcher, target.getAttribute('data-pkc-card-target'));
  },
  /**
   * `pkc://<自分>/asset/<key>` ── 添付の**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ key → lid の逆引きは storage worker(`findAssetOwner`)なので非同期 ──
   *   判断は services 側(main.ts が worker へ問い、見つかれば SELECT_ENTRY)。
   */
  'navigate-asset-ref': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-ref');
    if (key) services.navigateAssetRef?.(key);
  },
  /**
   * 一覧 / フォルダ / かんばん / カレンダーの行。
   *
   * 🔴 **編集中は無言で捨てられていた**(2026-08-08 に直した)。reducer が
   * `phase === 'editing'` で何もせず返すので、**押しても 1 ドットも動かず、
   * 理由もどこにも出ない** ── user から見ると「クリックが効かない」。
   * ⚠ 行は 4 つの面が出しているので、**受け手 1 か所で直すと 4 面とも直る**。
   */
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) selectEntryOrExplain(dispatcher, lid, 'ノート');
  },
  /**
   * ✏️ 編集に入る。#177: 多重タブでは**先に編集権を取ってから**入る。
   * ⚠ reducer のガード(ready / openBody 一致 / writeLock)は**ここに写さない**
   *   ── 取ってから dispatch し、入れなかったら返す(判定は reducer 1 か所)。
   */
  /**
   * 🔴 **タグで探す**(#182)。⚠ 押した札の語を**絞り込み欄へ入れる** ── 別建ての
   * タグ絞り込み機構を作らない(#181 の全文検索が frontmatter ごと引く)。
   * ⚠ 欄の値も state 経由で同期される(renderer が書き戻す)。
   */
  'filter-by-tag': (dispatcher, target) => {
    const tag = target.getAttribute('data-pkc-tag');
    if (tag) dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: tag });
  },
  /**
   * 🔴 **選択の戻る・進む**(#190)。⚠ **行き先をここで決めない** ── 履歴は state が
   * 持ち、`NAV_HISTORY` が行き先も採否も決める(binder が lid を選ぶと二重帳簿になる)。
   */
  /**
   * 🔴 **ペインを畳む・戻す**(#197)。⚠ **state に持たせない** ── これはこの端末の
   * 見え方であって、ノートのデータでも container の状態でもない(`editor-mode` と
   * 同じ扱い)。畳んだ状態は保存され、次に開いたときも同じ配置になる。
   */
  'toggle-pane': (_dispatcher, target) => {
    const id = target.getAttribute('data-pkc-pane');
    if (id === null || !isPaneId(id)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    applyPaneVisibility(root, appPanes.toggle(id));
  },
  /**
   * 🔴 **置換の帯を開く・閉じる**(#191)。⚠ 開いたら**探す欄へ focus** ──
   * 開いただけで打てないと、user は 2 手目を探すことになる。
   */
  'toggle-replace': (_dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="replace-bar"]');
    if (!bar) return;
    bar.hidden = !bar.hidden;
    target.setAttribute('aria-expanded', bar.hidden ? 'false' : 'true');
    if (!bar.hidden)
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.focus();
  },
  /**
   * 🔴 **全部置換**(#191)。⚠ 判定(編集中か / 何件当たるか)は**reducer 1 か所**。
   * ここでは欄の値を渡すだけ ── binder が「0 件なら押さない」等を持つと二重帳簿になる。
   */
  'replace-all': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const find = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.value ?? '';
    const replace =
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')?.value ?? '';
    dispatcher.dispatch({ type: 'REPLACE_IN_BODY', find, replace });
  },
  /**
   * 🔴 **関係を足す**(#185)。⚠ 相手は**題名で指す**(lid は user に見えない)。
   * ⚠ 見つからない / 曖昧なときは**理由を言う** ── 押して無反応にしない。
   * ⚠ 判定(自分自身・重複・居場所)は **reducer 1 か所**。ここは解決だけ。
   */
  'add-relation': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const nameEl = root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]');
    const kindEl = root.querySelector<HTMLSelectElement>('[data-pkc-field="relation-kind"]');
    const name = (nameEl?.value ?? '').trim();
    const state = dispatcher.getState();
    const fromLid = state.selectedLid;
    if (fromLid === null) return;
    if (name === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '相手の題名を入れてください' });
      return;
    }
    const hits = [...state.entryMetas.values()].filter(
      (m) => m.title === name && m.lid !== fromLid,
    );
    if (hits.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」というノートが見つかりません`,
      });
      return;
    }
    if (hits.length > 1) {
      // ⚠ 同じ題名が複数 ── **どれかを勝手に選ばない**(user の意図が決まらない)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」が ${hits.length} 件あります。題名を分けてから足してください`,
      });
      return;
    }
    const kind = kindEl?.value ?? '';
    if (!isRelationKind(kind) || kind === STRUCTURAL) return;
    dispatcher.dispatch({
      type: 'ADD_RELATION',
      id: generateLid(),
      fromLid,
      toLid: hits[0]!.lid,
      kind,
    });
    if (nameEl) nameEl.value = '';
  },
  /** 関係を消す(#185)。⚠ **id で消す**(押した札が持っている)。 */
  'remove-relation': (dispatcher, target) => {
    const id = target.getAttribute('data-pkc-relation');
    if (id) dispatcher.dispatch({ type: 'REMOVE_RELATION', id });
  },
  'nav-back': (dispatcher) => dispatcher.dispatch({ type: 'NAV_HISTORY', dir: 'back' }),
  'nav-forward': (dispatcher) => dispatcher.dispatch({ type: 'NAV_HISTORY', dir: 'forward' }),
  /** 一覧の並び順(#183)。⚠ 妥当性の判定は `isEntrySort` 1 か所。 */
  'set-entry-sort': (dispatcher, target) => {
    const v = (target as HTMLSelectElement).value;
    if (isEntrySort(v)) dispatcher.dispatch({ type: 'SET_ENTRY_SORT', sort: v });
  },
  /**
   * 集計の束ね方(#184)。⚠ 空文字は「選んでいない」── `null` へ落とす
   * (空文字の key で問い合わせると、全件が「未設定」の 1 組になる)。
   */
  'set-query-key': (dispatcher, target) => {
    const v = (target as HTMLSelectElement).value;
    const key = v === '' ? null : v;
    // ⚠ 覚えるのは**端末側**(container に書かない ── 作業の都合であってデータではない)
    appQueryKey.set(key);
    dispatcher.dispatch({ type: 'SET_QUERY_KEY', key });
  },
  /**
   * 数え直す(#184)。集計は保存のたびに自動では走らない(全本文の先頭を舐めるので、
   * 打つたびには回さない)。
   * 🔴 ⚠ **`SET_VIEW_MODE` を借りない**(レビュー B-2)── 借りると
   * `revisionPanel` / `trashPanel` が畳まれ、**ゴミ箱を開いたまま数え直すと
   * 理由なく閉じる**。P8 段⑤ で「アプリ」タブが同じ形の事故を起こしている。
   */
  'refresh-query': (dispatcher) => {
    dispatcher.dispatch({ type: 'REFRESH_QUERY' });
  },
  'start-edit': (dispatcher, _target, services) => {
    const lock = services.acquireEditLock;
    const lid = dispatcher.getState().openBody?.lid ?? null;
    /**
     * 🔴 **飛んでいる書込を待ってから始める**(#288)。⚠ 待たないと、
     * チェックの印を押した直後の編集で**押す前の本文**が入力欄に出て、
     * 打った時点で印が黙って戻る(2026-08-19 に smoke が実際に踏んだ)。
     * ⚠ 待つのは chain が空になるまで ── 何も飛んでいなければその場で返る。
     */
    /**
     * ⚠ **渡されていない環境では今までどおり同期に始まる**(`null`)── test の
     *   fake や旧い配線を非同期に変えない(乗せ換えたとき unit が 40 件落ちた)。
     */
    const ready = services.settle?.() ?? null;
    if (!lock || lid === null) {
      if (ready === null) dispatcher.dispatch({ type: 'START_EDIT' });
      else void ready.then(() => dispatcher.dispatch({ type: 'START_EDIT' }));
      return;
    }
    void (ready === null ? lock(lid) : ready.then(() => lock(lid))).then((grant) => {
      if (grant !== 'granted') {
        // ⚠ 文言は理由と対(§1 / レビュー M-7)── holder 不在を「別のタブで編集中」と
        //    言うと、user は存在しない編集タブを探す
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error:
            grant === 'denied'
              ? 'このノートは別のタブで編集中です(そちらを閉じるか保存してください)'
              : '本体タブと通信できません(少し待ってもう一度お試しください)',
        });
        return;
      }
      // 🔴 dispatch の**前**に自分の lid か確かめる(レビュー M-3)── acquire を待つ間に
      //    user が別のノートを選んでいると、reducer は**そのノート**の編集を受理する
      //    = ロック無しの編集が成立してしまう。dispatch は同期なのでここの検査に窓は無い
      if (dispatcher.getState().openBody?.lid !== lid) {
        services.releaseEditLock?.(lid);
        return;
      }
      dispatcher.dispatch({ type: 'START_EDIT' });
      // ⚠ 「editing に居るか」では足りない ── reducer が断る理由は選択以外にもある
      //    (writeLock / tileWrite 中)。**自分の lid が入ったか**で見る
      const st = dispatcher.getState();
      if (!(st.phase === 'editing' && st.openBody?.lid === lid))
        services.releaseEditLock?.(lid);
    });
  },
  // ⚠ 第 4 引数の **root** を使う(target ではない)── 追記欄の出口は detail の
  //    兄弟なので、押したボタンから題名欄へは辿れない(P8 段⑲)
  'commit-edit': (dispatcher, _target, _services, root) => {
    renameFromEditorInput(dispatcher, root);
    dispatcher.dispatch({ type: 'COMMIT_EDIT' });
  },
  'cancel-edit': (dispatcher, _target, _services, root) => cancelFromEditor(dispatcher, root),
  'create-entry': (dispatcher, target, services) => {
    // 🔑 種類は**隣の `<select>`**から取る(P8 ── ボタンを種類ぶん並べない)。
    // ⚠ 旧来どおりボタン自身が `data-pkc-archetype` を持つ形も受ける
    // (かんばん等の面から直接作る導線が将来生えても壊れない)
    const archetype =
      target.getAttribute('data-pkc-archetype') ??
      target
        .closest('[data-pkc-region="create-bar"]')
        ?.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]')?.value ??
      null;
    if (!archetype) return;
    /**
     * 🔴 **いま見ているフォルダの中に作る**(2026-08-05、user 報告
     * 「フォルダ整理のための導線がない」の片翼)。直す前は、フォルダを開いて
     * 「+ ノート」を押しても**ルートに落ちて**いた ── フォルダの中身は
     * 「作ってから入れ直す」以外に増やしようが無かった。
     *
     * ⚠ 入れ先は**いま見ているフォルダ**(#240 段① で `scopeLid` へ移した)。
     * それより前は**選択の純関数**(`resolveFilerScope`)だったので、一覧で別の
     * ノートを選ぶだけで**作る先が変わって**いた ── いまは画面に出ているパンくずと
     * 作る先が必ず一致する。「どの探し方を開いているか」では変えない、は不変。
     * ⚠ `SET_VIEW_MODE` より**前**に読む(切替は選択を動かさないが、
     * 読む順を先に固定しておく)。
     */
    const st = dispatcher.getState();
    const parent = st.scopeLid === null ? null : (st.entryMetas.get(st.scopeLid) ?? null);
    // 非 detail view で作ると editor が出ない(PKC2 PR-Δ19 の罠)── 先に切替
    if (st.viewMode !== 'detail') dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype,
      lid,
      title: defaultTitle(dispatcher, archetype),
      parentLid: parent?.lid ?? null,
      relationId: generateLid(),
    });
    // #177: 作成 → 即編集の編集権。lid は今生まれたばかりなので必ず取れる ──
    // 「取れてから入る」順に直すと user gesture の同期性を失うだけで守るものが無い。
    // 別タブは 'changed' でこの lid を知るため、登録が先に着けばよい
    if (dispatcher.getState().phase === 'editing') void services.acquireEditLock?.(lid);
  },
  /**
   * 🔴 **まとめてゴミ箱へ**(#240 段③。user 指示 2026-08-17「まとめて消せない」)。
   *
   * ⚠ 断り方・確認・戻せることの言い方は `delete-entry` と**同じ規則**にする
   * (押した場所が違っても、同じ理由なら同じ言い方 ── CLAUDE.md「文言は押した
   * 場所と対で pin する」)。⚠ 完全削除は一括で撃たせない(戻せない操作は 1 件ずつ)。
   */
  'delete-selected': (dispatcher, _target, services) => {
    const st = dispatcher.getState();
    // ⚠ 押した場所は**左の列**なので、相手も左の列の集合(2 ペインの印を巻き込まない)
    deleteFrom(dispatcher, services, visibleFilerRows(st), st.selection);
  },
  /** 印を全部外す(#240 段②)。 */
  'clear-selection': (dispatcher) => dispatcher.dispatch({ type: 'CLEAR_SELECTION' }),
  // ── 2 ペインタブファイラ(#241 段⑥-a)──────────────────────────
  // ⚠ 側は**押した物から辿る**(`data-pkc-side`)── 面の側を state から
  //    推測すると、焦点の無いほうを押したときに反対側が動く
  'dual-focus': (dispatcher, target) => {
    const side = dualSide(target);
    if (side) dispatcher.dispatch({ type: 'DUAL_FOCUS', side });
  },
  'dual-row': (dispatcher, target) => {
    const side = dualSide(target);
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry');
    // ⚠ 修飾なしのクリックは「これだけを相手にする」── 印は 1 件になる
    if (side && lid) dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'set' });
  },
  'dual-crumb': (dispatcher, target) => {
    const side = dualSide(target);
    if (!side) return;
    // ⚠ `data-pkc-entry` を持たないパンくず = ルート(`null`)
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid });
  },
  'dual-tab-add': (dispatcher, target) => {
    const side = dualSide(target);
    if (side) dispatcher.dispatch({ type: 'DUAL_TAB_ADD', side });
  },
  'dual-tab-close': (dispatcher, target) => {
    const side = dualSide(target);
    const index = dualTabIndex(target);
    if (side && index !== null) dispatcher.dispatch({ type: 'DUAL_TAB_CLOSE', side, index });
  },
  'dual-tab-activate': (dispatcher, target) => {
    const side = dualSide(target);
    const index = dualTabIndex(target);
    if (side && index !== null) dispatcher.dispatch({ type: 'DUAL_TAB_ACTIVATE', side, index });
  },
  /**
   * 🔴 **いま開いている場所にフォルダを作る**(#273 段②)。
   *
   * ⚠ **編集に入らない**(`edit: false`)── 入ると中央が本文の面へ切り替わり、
   *   整理の途中で面から放り出される。作ったら**その場に出る**のが FD の作法である。
   * ⚠ 入れ先は**そのペインが開いている場所**(左の列の現在地ではない)。
   */
  /** 🔴 押しボタンからも名前を打ち替えられる(鍵は F2 ── 実体は同じ action)。 */
  'dual-rename-begin': (dispatcher, target) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから名前を変えてください' });
      return;
    }
    const marked = paneOf(st.dual, side).selection;
    // ⚠ **1 件のときだけ** ── まとめて改名は「同じ名前が並ぶ」だけで意味が無い
    if (marked.length !== 1) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          marked.length === 0
            ? '名前を変えるものを選んでください(行を押すと選べます)'
            : '名前を変えられるのは 1 件だけです',
      });
      return;
    }
    dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side, lid: marked[0]! });
  },
  'dual-mkdir': (dispatcher, target) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してからフォルダを作ってください',
      });
      return;
    }
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'folder',
      lid: generateLid(),
      title: '新しいフォルダ',
      parentLid: paneScope(paneOf(st.dual, side)),
      relationId: generateLid(),
      edit: false,
    });
  },
  /**
   * 🔴 **反対側の場所へ写す**(#273 段③。FD の C 相当)。
   *
   * ⚠ **フォルダを写したら中身も行く** ── 段取りは純関数 `planCopy` が決める
   *   (親子の組み直しを adapter に書くと、どの test からも実行されずに壊れる)。
   * ⚠ 本文が読めなかったぶんは**件数で言う** ── 黙って空のノートを作らない。
   */
  'dual-copy': (dispatcher, target, services) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから写してください' });
      return;
    }
    const rows = filerRows(paneScope(paneOf(st.dual, side)), st.entryMetas, st.relations, {
      filterQuery: st.filterQuery,
      searchHits: st.searchHits,
      sort: st.entrySort,
    });
    // ⚠ 数える相手は**いま表に出ている印**だけ(移す・消すと同じ規則)
    const lids = visibleSelection(rows, paneOf(st.dual, side).selection);
    if (lids.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '写すものを選んでください(行を押すと選べます)',
      });
      return;
    }
    const read = services.readBodies;
    if (!read) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この版では写せません' });
      return;
    }
    const to = otherSide(side);
    const steps = planCopy(
      lids,
      paneScope(paneOf(st.dual, to)),
      st.entryMetas,
      st.relations,
      generateLid,
    );
    void read(steps.map((s) => s.sourceLid)).then(
      (bodies) => {
        let missing = 0;
        for (const step of steps) {
          const body = bodies.get(step.sourceLid);
          if (body === undefined) missing += 1;
          dispatcher.dispatch({
            type: 'CREATE_ENTRY',
            archetype: step.archetype,
            lid: step.lid,
            title: step.title,
            parentLid: step.parentLid,
            relationId: generateLid(),
            edit: false,
            ...(body === undefined ? {} : { body }),
          });
        }
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error:
            missing > 0
              ? `${steps.length} 件を写しました(うち ${missing} 件は本文を読めず、空で作りました)`
              : `${steps.length} 件を写しました`,
        });
      },
      () => dispatcher.dispatch({ type: 'OP_FAILED', error: '写せませんでした(本文を読めません)' }),
    );
  },
  /** ⚠ 鍵(`Delete`)と**同じ実体**を押しボタンからも呼ぶ(規則を 2 つ作らない)。 */
  'dual-delete': (dispatcher, target, services) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    deleteFrom(
      dispatcher,
      services,
      filerRows(paneScope(paneOf(st.dual, side)), st.entryMetas, st.relations, {
        filterQuery: st.filterQuery,
        searchHits: st.searchHits,
        sort: st.entrySort,
      }),
      paneOf(st.dual, side).selection,
    );
  },
  /**
   * 🔴 **反対側の場所へ移す**(この面の主目的)。
   *
   * ⚠ **実体は `moveEntries` 1 本**(帯の `<select>` / D&D と同じ)── 断り方も
   *   「付いていく」の規則も経路で変えない(§7「判定を増やさない」)。
   * ⚠ 数える対象は**いま表に出ている印**だけ ── 素で数えると、画面に無いものが
   *   動く(#240 の着地前レビュー 2)。
   * ⚠ **黙って断らない** ── 何も選んでいないときは、その理由を出す。
   */
  'dual-move': (dispatcher, _target, services) => {
    const st = dispatcher.getState();
    const from = st.dual.focus;
    const pane = paneOf(st.dual, from);
    const rows = filerRows(paneScope(pane), st.entryMetas, st.relations, {
      filterQuery: st.filterQuery,
      searchHits: st.searchHits,
      sort: st.entrySort,
    });
    const lids = visibleSelection(rows, pane.selection);
    if (lids.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '移すものを選んでください(行を押すと選べます)',
      });
      return;
    }
    const to = paneScope(paneOf(st.dual, otherSide(from)));
    const before = st.relations;
    moveEntries(dispatcher, lids, to, services.showStatus);
    /**
     * 🔴 **動いた回だけ印を外す**(着地前レビュー R1)。
     * ⚠ `moveEntries` は編集中・全件拒否で**何もせず返る**ので、無条件に外すと
     *   **1 件も動いていないのに 30 件の印が消える** ── user は断りを読んで
     *   保存してから戻り、**選び直し**になる(この面は編集中でも開ける設計なので
     *   必ず踏む筋である)。
     * 🔑 印は「移した結果」に付いていく物であって、**押した事実**に付く物ではない。
     */
    if (dispatcher.getState().relations !== before)
      dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: from });
  },
  'delete-entry': (dispatcher, target) => {
    // ⚠ 実行中(書出し / 取込)のガードは `refuseWhileBusy` が 1 本で持つ
    // 🔴 **無言で断らない**(P8 段⑲)。`DELETE_ENTRY` は `phase !== 'ready'` で
    //    何も返さないので、直す前は**確認ダイアログまで出してから黙って捨てて**いた
    //    ── user は消したつもりで画面を離れる。detail.ts が確立した
    //    「無言の操作拒否を作らない」に揃える。⚠ confirm より**前**に断る
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから削除してください',
      });
      return;
    }
    // 属性はボタン自身ではなく「entry を表す要素」(行 / カード)から closest で
    // 引く ── ボタン直付けだと selectedLid fallback が別 entry を消す罠になる
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (!lid) return;
    const title = dispatcher.getState().entryMetas.get(lid)?.title ?? lid;
    // P3-7a は native confirm(inline dialog は UI 磨きの回で)。
    // 🔴 文言が**嘘になっていた**(P7 段⑥ round-2 review M-8)。P3-7a の時点では
    // hard delete だったので「元に戻せません」と書いたが、P5b でゴミ箱と復元が
    // 着地している(削除直前の snapshot を同 tx で積み、`RESTORE_TRASH` で戻せる)
    // ── **必要以上に怖がらせる側の嘘**を出荷していた。
    // ⚠ 「戻せる」ことは `docs/manual.md` §6 にも書いてある(そちらが正しかった)
    // confirm の無い環境(headless test)は自動化として通す
    // 🔴 **抑止されていたら理由を出す**(2026-08-06。user 報告 minor)── 黙って
    //    false が返るので、そのままだとボタンが恒久的に無反応に見える
    if (!confirmOrExplain(dispatcher, `「${title}」を削除しますか?(ゴミ箱から戻せます)`, true))
      return;
    dispatcher.dispatch({ type: 'DELETE_ENTRY', lid });
  },
  'copy-md-block': (_dispatcher, target) => handleCopyMdBlock(target),
  /**
   * 🔴 **読む面のコピー**(2026-08-08。user 裁定「markdown のテキストとしての
   * コピーと HTML 書式ありのコピーの両方」)。押しても画面が変わらない操作なので、
   * 渡ったらボタンが光り(`copy-md-block` と同じ合図)、渡らなければ理由が出る。
   * ⚠ 本文待ちの間は renderer 側が disabled にしている ── ここの早期 return は
   * その裏書き(押せない物は押せない)であって、無言の断りの口ではない。
   */
  'copy-note-md': (dispatcher, target) => {
    const body = dispatcher.getState().openBody?.body;
    if (body === undefined) return;
    finishCopy(dispatcher, target, copyPlainText(body));
  },
  /**
   * 🔴 **よそのアプリへ貼る用に掃除してから渡す**(#193)。
   *
   * ⚠ 直す前は `host.innerHTML` を**そのまま**渡していた ── 画面の DOM には
   * 「CSS で隠してあるだけのソース」「押せない操作子」「この document でしか
   * 有効でない `blob:` 画像」が入っており、Word / Notion に貼ると**全部出る**
   * (図の下に生の原文、壊れた画像、押せないボタン)。
   * ⚠ 掃除は**複製に対して**行う ── 画面には触れない。
   * ⚠ 落としたものは**数えて言う**(黙って消さない)。
   */
  'copy-note-rich': (dispatcher, target, services, root) => {
    const body = dispatcher.getState().openBody?.body;
    const host = viewBodyHost(root);
    if (body === undefined || host === null) return;
    const clone = host.cloneNode(true) as HTMLElement;
    const inline = services.inlineImages;
    const run = (urls: ReadonlyMap<string, string>): void => {
      const { html, droppedImages } = cleanForClipboard(clone, urls);
      // plain 側は原文(markdown)── 貼り付け先が editor なら原文、rich なら描画
      finishCopy(dispatcher, target, copyMarkdownAndHtml(body, html));
      if (droppedImages > 0)
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `画像 ${droppedImages} 件は貼り先で読めないため文字に置き換えました`,
        });
    };
    if (!inline) {
      run(new Map());
      return;
    }
    const blobs = [...clone.querySelectorAll('img')]
      .map((i) => i.getAttribute('src') ?? '')
      .filter((u) => u.startsWith('blob:'));
    if (blobs.length === 0) {
      run(new Map());
      return;
    }
    void inline(blobs).then(run, () => run(new Map()));
  },
  /**
   * 選択範囲を Markdown の原文でコピーする。逆引きの規則は `copy-source.ts` の
   * 1 本(活性の判定と同じ端点の規則)。
   * ⚠ 解決できない選択は**理由を出す**(活性が selectionchange と競り合って
   * 押せてしまう瞬間があるので、ここでも無言にしない)。
   */
  'copy-selection-md': (dispatcher, target, _services, root) => {
    const body = dispatcher.getState().openBody?.body;
    const host = viewBodyHost(root);
    const text = body !== undefined && host !== null ? selectedMarkdown(host, body) : null;
    if (text === null) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '本文の中を選択してからコピーしてください',
      });
      return;
    }
    finishCopy(dispatcher, target, copyPlainText(text));
  },
  /**
   * 書式パネル(P8 段⑥)。⚠ **規則は `applyFormat` が持つ** ── ここは
   * 「選択を読む → 渡す → 書き戻す」だけ。op ごとの知識をここに漏らさない。
   */
  'format-text': (_dispatcher, target, _services, root) => {
    const op = target.getAttribute('data-pkc-format') as FormatOp | null;
    // ⚠ live の 1 面では活性の行(`row-source`)に効く(`formatTarget` の注記)
    const ta = formatTarget(root);
    if (!op || !ta) return;
    writeBack(ta, applyFormat({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, op));
  },
  /**
   * 🔑 **追記**(P8 段⑧)。編集画面を開かず、打った内容をそのまま末尾へ足す。
   *
   * 🔴 段⑥ の「編集に入って末尾へ飛ぶ」は**作り直した**(user 指示 2026-08-03
   * 「追記型は今すぐ実装して、今のままだと、なんの意味もない」)── 5000 行の
   * ログでも毎回全文を textarea に載せる形は、追記型の意味を成していなかった。
   *
   * ⚠ 日時見出しは**ここで作る**(reducer は純粋のまま ── `Date` を呼ばない)。
   * ⚠ 欄は**空にしない** ── 通ったときだけ描画側が空にする(失敗で打鍵が消えない)。
   */
  'append-entry': (dispatcher, _target, _services, root) => {
    const s = dispatcher.getState();
    const lid = s.selectedLid;
    const archetype = lid ? s.entryMetas.get(lid)?.archetype : undefined;
    if (!lid || !isAppendable(archetype)) return;
    const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    const text = input?.value ?? '';
    // ⚠ **空判定をここに持たない**(P8 段⑧ の変異試験で判明)── reducer が
    // 同じ判定を持っており、3 か所(binder / reducer / `appendBlock`)が互いに
    // 救い合って**どれ 1 つ消しても test が緑**だった。判定は下 2 つに寄せる:
    // reducer =「ロックも取らずに断る」、`appendBlock` =「本文を変えない」
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid,
      text,
      heading: appendHeadingFor(archetype!, new Date()),
    });
  },
  /**
   * 🔴 **強制解放**(user 指示 2026-08-03「競合ロックと強制解放も念頭に」)。
   * 返ってこない書込で**永久に追記できなくなる**のを防ぐ最後の出口。
   * ⚠ 押した人が結果を分かっていること ── 確認を出す(確認の無い環境は通す)。
   */
  'force-release': (dispatcher) => {
    const ok = confirmOrExplain(
      dispatcher,
      '追記の書き込みを強制的に打ち切ります。書き込みが実際には進んでいた場合、' +
        'この画面の表示が実際の中身より古くなることがあります(開き直すと直ります)。よろしいですか?',
      true,
    );
    if (ok) dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
  },
  /** 左の列の**探し方**を切り替える(P8 段⑤)。⚠ 中央のビューとは別の軸。 */
  'set-browse': (_dispatcher, target, services) => {
    const mode = target.closest('[data-pkc-browse]')?.getAttribute('data-pkc-browse');
    if (mode) services.setBrowse?.(mode);
  },
  'set-view': (dispatcher, target) => {
    const view = target.getAttribute('data-pkc-view') ?? '';
    if (!isViewMode(view)) return;
    // 🔴 **もう一度押したら戻る**(P8 段⑲)。直す前の 設定 は行きっぱなしで、
    //    閉じる導線がどこにも無かった ── 抜けられるのは左のタブを押すか
    //    新規作成だけで、user から見ると「画面から出られない」
    const cur = dispatcher.getState().viewMode;
    // ⚠ cast を置かない ── `isViewMode` が絞ってあるので、表と食い違えば型が落ちる
    // 🔑 規則は 1 か所(`nextViewMode`)── タイルから開く面も同じ関数を通る
    const next: ViewMode = nextViewMode(cur, view);
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: next });
    /**
     * 🔴 **集計の束ね方を思い出す**(#184)。⚠ **開いたときだけ**読む ──
     * boot で読むと、集計を一度も開かない user にも全本文の走査を負わせる。
     * ⚠ 順序が効く: 先に `SET_VIEW_MODE`(目録を頼む)→ 後に `SET_QUERY_KEY`
     * (表を頼む)。逆にすると同じ走査を 2 回頼むことになる。
     */
    /**
     * ⚠ **実際に開けたときだけ**(レビュー B-1)── 1 稿目は `next` を見ていたので、
     * **編集中に押すと面は開かないのに走査だけ飛んで**いた(`SET_VIEW_MODE` は
     * 編集中に捨てられるが、`SET_QUERY_KEY` にはその門が無い)。
     */
    if (dispatcher.getState().viewMode === 'query' && dispatcher.getState().queryKey === null) {
      const remembered = appQueryKey.get();
      if (remembered !== null) dispatcher.dispatch({ type: 'SET_QUERY_KEY', key: remembered });
    }
  },
  'toggle-todo': (dispatcher, target) => {
    // data-pkc-entry は「entry を表す要素」専用 ── ボタンからは closest で引く
    const lid = target
      .closest('[data-pkc-entry]')
      ?.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'TOGGLE_TODO_STATUS', lid });
  },
  /**
   * 🔴 **カレンダーに書ける導線**(#276 の 4。「読むだけにしない」)。
   *
   * 選んでいるノートの frontmatter に `date` を入れる。⚠ 同じ日をもう一度押すと
   * **外す**(付けた本人が外せない導線を作らない)。
   * ⚠ **黙って断らない** ── 何も選んでいない / 編集中は、理由を出す。
   */
  /**
   * 🔴 **チェックの印を押せるようにする**(#277。user 指示 2026-08-19
   * 「チェックリストを含む場合の自動生成で…復活させるのです」)。
   *
   * ⚠ 押せるのは**読む面**だけ(描画側が `interactiveTasks` を渡した所)。
   * ⚠ 指すのは**原文の行番号** ── 索引だと数え方のずれで別の行を書き換える。
   */
  'toggle-task': (dispatcher, target) => {
    const raw = target.getAttribute('data-pkc-task-line');
    const line = Number(raw);
    if (raw === null || !Number.isInteger(line) || line < 0) return;
    const st = dispatcher.getState();
    /**
     * 🔴 **どのノートの行かは、押した所から引く**(#277 段②-b で直した)。
     *
     * ⚠ 直す前は `openBody?.lid ?? selectedLid` だけを見ていた ── 本文の面では
     *   合っているが、**カンバンの札は別のノートの行**なので、押すと
     *   **開いているノートの同じ行番号**を書き換える(いちばん静かなデータ破壊)。
     * 🔑 札には `data-pkc-entry` が焼いてあるので、そこから引く。
     * ⚠ 本文の面は `data-pkc-entry` を持たない(器はノートを表す要素ではない)
     *   ので、そのときだけ「いま開いているノート」へ落ちる。
     */
    const fromDom = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    const lid = fromDom ?? st.openBody?.lid ?? st.selectedLid;
    if (lid === null || lid === undefined) return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してからチェックしてください' });
      return;
    }
    dispatcher.dispatch({ type: 'TOGGLE_TASK', lid, line });
  },
  'calendar-set-date': (dispatcher, target) => {
    const date = target.closest('[data-pkc-date]')?.getAttribute('data-pkc-date');
    if (date === null || date === undefined) return;
    const st = dispatcher.getState();
    /**
     * ⚠ **セルの中のノートを押したときは、そちらが勝つ**(`select-entry`)──
     * ここへは「日付の地」を押したときだけ来る。押した所と起きることを一致させる。
     */
    const lid = st.selectedLid;
    if (lid === null) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '日付を付けるノートを先に選んでください(一覧から押すと選べます)',
      });
      return;
    }
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから日付を変えてください' });
      return;
    }
    const meta = st.entryMetas.get(lid);
    if (!meta) return;
    // 🔑 同じ日をもう一度押したら外す(付けたものを外せる)
    dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date: meta.date === date ? null : date });
  },
  'calendar-nav': (dispatcher, target) => {
    // 遷移先は renderer が描画時に焼き込む(binder は「今の月」を推定しない)
    const year = Number(target.getAttribute('data-pkc-nav-year'));
    const month = Number(target.getAttribute('data-pkc-nav-month'));
    if (!Number.isInteger(year) || !Number.isInteger(month)) return;
    dispatcher.dispatch({ type: 'SET_CALENDAR_MONTH', year, month });
  },
  'calendar-today': (dispatcher) => {
    const now = new Date();
    dispatcher.dispatch({
      type: 'SET_CALENDAR_MONTH',
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });
  },
  'toggle-show-archived': (dispatcher) =>
    dispatcher.dispatch({ type: 'TOGGLE_SHOW_ARCHIVED' }),
  'retry-persist': (dispatcher) => dispatcher.dispatch({ type: 'RETRY_PERSIST' }),
  /**
   * 🔴 **フォルダへ入る / ルートへ戻る**(#240 段①)。
   *
   * ⚠ 直す前、パンくずのルートは `DESELECT_ENTRY` を撃っており、**現在地を戻すと
   * 中央のノートまで閉じて**いた(現在地が `selectedLid` の純関数だったため、
   * ルート表示 = 選択解除しか書きようが無かった)。現在地を state に持った今は、
   * **選択に触らずに現在地だけ**動かす。
   * ⚠ 押した要素が `data-pkc-entry` を持たなければ**ルート**(パンくずの先頭)。
   */
  'enter-folder': (dispatcher, target) => {
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    dispatcher.dispatch({ type: 'SET_SCOPE', lid });
  },
  /**
   * 🔴 **居場所を変える**(2026-08-05、user 報告「フォルダ整理のための導線がない」)。
   * 空値 = ルートへ出す。⚠ 動かす当人は**帯自身**が持っている
   * (`selectedLid` を読み直すと、選び直した直後に別のものを動かす)。
   */
  'move-entry': (dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (!lid) return;
    const value = target instanceof HTMLSelectElement ? target.value : '';
    // 🔴 実体は `moveEntries` 1 本(D&D と同じ ── 断り方も知らせ方も揃う)
    moveEntries(dispatcher, [lid], value === '' ? null : value, services.showStatus);
  },
  /**
   * 🔴 **並べ替え**(2026-08-06。user 報告 2-10)。⚠ 動かす当人は帯が持つ
   * (`move-entry` と同じ理由 ── 押した瞬間に選択が変わっていても取り違えない)。
   */
  'move-order-up': (dispatcher, target) => moveOrder(dispatcher, target, 'up'),
  'move-order-down': (dispatcher, target) => moveOrder(dispatcher, target, 'down'),
  'attach-file': (_dispatcher, target) => {
    // 常設の hidden input を開く(動的生成にしない ── smoke の setInputFiles と
    // ブラウザの user-gesture 要件の両方に効く)
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')
      ?.click();
  },
  /**
   * 図を保存する(P8 段⑦)。⚠ 画面は PNG だが、**書き出すのはベクタ**
   * (user 指示 2026-08-03「SVG は書き出しのときだけ」)。
   * ⚠ 「何枚目か」は**描いた側の並び**から数える ── 器に番号を焼き込むと、
   * 図を 1 個消したときに番号が飛ぶ
   */
  'export-diagram': (_dispatcher, target, services, root) => {
    const host = target.closest<HTMLElement>('[data-pkc-mermaid-src]');
    const source = host?.getAttribute('data-pkc-mermaid-src');
    if (!host || !source) return;
    const all = [...root.querySelectorAll('[data-pkc-mermaid-src]')];
    const done = services.exportDiagram?.(source, Math.max(0, all.indexOf(host)));
    // 🔴 **無言で待たせない**(P8 段⑬ review M-3)。ベクタは原文から焼き直すので、
    //    mermaid 本体の読み込みを含めて秒が掛かる。何も起きないように見えると
    //    user は連打する ── 押せなくして、そのボタン自身に状態を出す
    const btn = target.closest<HTMLButtonElement>('[data-pkc-action="export-diagram"]');
    if (!btn || !(done instanceof Promise)) return;
    const label = btn.querySelector<HTMLElement>('[data-pkc-field="label"]');
    const was = label?.textContent ?? '';
    btn.disabled = true;
    btn.setAttribute('data-pkc-busy', '');
    if (label) label.textContent = '書き出し中…';
    const reset = (): void => {
      btn.disabled = false;
      btn.removeAttribute('data-pkc-busy');
      if (label) label.textContent = was;
    };
    // ⚠ **`finally` ではなく `then(reset, reset)`** ── `finally` は元の失敗を
    //    そのまま流すので、service が reject すると**未処理の rejection**になる
    //    (実際に test の stderr で出た。この repo は stderr 0 行を保つ規律)。
    //    失敗の**報告**は service 側が持つ ── ここは見た目を戻すだけ
    void done.then(reset, reset);
  },
  /**
   * ランチャーのタイル設定(P8 段⑭)。
   * ⚠ 対象は**いま選んでいるノート** ── この 3 つは添付の画面にしか出ない
   */
  'toggle-app-tile': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, registered: target.checked });
  },
  'set-app-group': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, group: target.value.trim() });
  },
  'set-app-icon': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, icon: target.value.trim() });
  },
  /**
   * 添付の参照(`asset:<key>`)をコピーする(P8 段⑱)。
   * ⚠ 本文に貼れる形そのものを渡す ── key だけ渡すと user が書式を覚える必要がある
   */
  'copy-asset-ref': (_dispatcher, target, services) => {
    // ⚠ 渡すのは**貼れる 1 行**(`![名前](asset:key)`)── 裸の `asset:key` を
    //    渡していた頃は、貼っても markdown としてはただの文字列だった(段⑱)。
    //    組み立ては描画側(`asset-ref-format.ts` 経由)。ここでは組み立て直さない
    const ref = target
      .closest<HTMLElement>('[data-pkc-asset-ref]')
      ?.getAttribute('data-pkc-asset-ref');
    if (ref) services.copyText?.(ref);
  },
  'download-asset': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? 'download';
    if (key) services.downloadAsset?.(key, name);
  },
  /**
   * 🔴 **画像を別窓で見る**(#192)。⚠ 開けなかったとき(popup 阻止)の後始末は
   *   呼ばれる側が持つ ── ここで持つと、経路が増えたときに片方だけ古くなる。
   */
  'view-asset': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? '添付';
    // ⚠ MIME を**押した要素から**運ぶ ── 開く側で引き直すと、開くまでに
    //    選択が移った場合に**別の添付の種類**で開いてしまう
    const mime = target.getAttribute('data-pkc-asset-mime') ?? '';
    if (key) services.viewAsset?.(key, name, mime);
  },
  'dismiss-notices': (_dispatcher, _target, services) => {
    services.dismissNotices?.();
  },
  'open-tile': (_dispatcher, target, services) => {
    const lid = target.closest('[data-pkc-tile]')?.getAttribute('data-pkc-tile');
    if (lid) services.openTile?.(lid);
  },
  /**
   * 🔑 **作る種類の一覧を開く / 閉じる**(P10 の分割ボタン)。
   * ⚠ `<details>` を使わない ── この repo は「主要な導線を畳まない」を規律に持ち、
   *   shell に `<details>` が 0 件であることを test で pin している。
   */
  'toggle-create-menu': (_dispatcher, target, _services, root) => {
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    target.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
  /**
   * 🔑 **作る種類を選ぶ**(P10)。押した種類を「いま作るもの」にして、
   * **本体のボタンの文言・図案**と **`Ctrl+N` の対象**を同時に切り替える。
   * ⚠ 保持場所は `<select>` 1 か所 ── ボタンの属性と select が食い違うと、
   *   押した種類と出来るものが別になる(いちばん困る形)。
   */
  'pick-create-kind': (_dispatcher, target, _services, root) => {
    const archetype = target.getAttribute('data-pkc-archetype');
    if (!archetype) return;
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]');
    if (select) select.value = archetype;
    const run = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    if (run) {
      run.setAttribute('data-pkc-archetype', archetype);
      const label = run.querySelector('[data-pkc-field="label"]');
      // ⚠ 文言は**選んだ項目の文言**をそのまま使う(表を 2 つ持たない)
      const picked = target.querySelector('[data-pkc-field="label"]')?.textContent ?? archetype;
      if (label) label.textContent = `+ ${picked}`;
      const icon = run.querySelector('[data-pkc-icon]');
      // ⚠ `textContent` で書かない(図案は要素)── `setIcon` で入れ替える
      if (icon) setIcon(icon, ARCHETYPE_ICONS[archetype] ?? 'dot');
    }
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu) menu.hidden = true;
    root
      .querySelector('[data-pkc-field="create-pick"]')
      ?.setAttribute('aria-expanded', 'false');
  },
  // ⚠ 対象は**いま選んでいる添付** ── 詳細画面のボタンなので lid は state が持つ
  'launch-asset': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { sameOrigin: false });
  },
  'launch-asset-raw': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { sameOrigin: true });
  },
  /**
   * 🔴 **Office の別窓で開く**(#88 / O3-c)。
   *
   * ⚠ **同期のうちに渡しきる。** 窓は user gesture の中でしか開けないので、
   * ここで lid から本文を読み直す(= `await`)ことはできない ── 開くのに要る
   * 4 つは**押したボタンの属性**に載っている(`office-entry-view.ts` が載せる)。
   */
  'open-office': (_dispatcher, target, services) => {
    const assetKey = target.getAttribute('data-pkc-asset-key');
    if (!assetKey) return;
    services.openOffice?.({
      assetKey,
      name: target.getAttribute('data-pkc-asset-name') ?? '',
      mime: target.getAttribute('data-pkc-asset-mime') ?? '',
      // 🔴 **保存の戻り先**(#205)。⚠ 読み落とすと、Office での上書き保存が
      //    このノートを更新せず、新しい添付ノートを増やす
      lid: target.getAttribute('data-pkc-office-lid') ?? '',
    });
  },
  /**
   * Office 一式(#88 / O6-a)。⚠ どれも**実体が判断を持つ** ── ここは渡すだけ。
   * ⚠ `choose-office-pack` は picker を開くだけ(`attach-file` と同じ作法で、
   *   input は常設 hidden。動的生成にすると user gesture の要件を外す)。
   */
  'install-office-pack': (_dispatcher, _target, services) => {
    services.installOfficePack?.();
  },
  'choose-office-pack': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="settings-office"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="office-pack-input"]')
      ?.click();
  },
  'remove-office-pack': (_dispatcher, _target, services) => {
    services.removeOfficePack?.();
  },
  'set-theme': (_dispatcher, target, services) => {
    // `<select>` なら選ばれた値、ボタンなら属性(どちらの形でも受ける)
    const theme =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-theme-value');
    if (theme) services.setTheme?.(theme);
  },
  'set-external-images': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-external-images-value');
    if (mode) services.setExternalImages?.(mode);
  },
  'set-page-format': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const format =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-page-format-value');
    if (format) services.setPageFormat?.(format);
  },
  'set-editor-mode': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-editor-mode-value');
    if (mode) services.setEditorMode?.(mode);
  },
  'set-flag': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    const name = target.getAttribute('data-pkc-flag');
    if (name && target instanceof HTMLInputElement) services.setFlag?.(name, target.checked);
  },
  'reset-flags': (_dispatcher, _target, services) => {
    services.resetFlags?.();
  },
  'allow-external-images': (_dispatcher, _target, services) => {
    services.answerExternalImages?.(true);
  },
  'deny-external-images': (_dispatcher, _target, services) => {
    services.answerExternalImages?.(false);
  },
  'apply-update': (_dispatcher, _target, services) => {
    services.applyUpdate?.();
  },
  'dismiss-update': (_dispatcher, _target, services) => {
    services.dismissUpdate?.();
  },
  /**
   * 「開く」で編集に入るかの設定(user 裁定 2026-08-18)。
   * ⚠ `set-notices-enabled` と同じ作法 ── checkbox の `checked` をそのまま渡す。
   */
  'set-open-in-edit': (_dispatcher, target, services) => {
    if (target instanceof HTMLInputElement) services.setOpenInEdit?.(target.checked);
  },
  'set-notices-enabled': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setNoticesEnabled?.(target.checked);
  },
  'dismiss-announce': (_dispatcher, _target, services) => {
    services.dismissAnnounce?.();
  },
  'mute-announce': (_dispatcher, _target, services) => {
    services.muteAnnounce?.();
  },
  'export-archive': (_dispatcher, _target, services) => {
    services.exportArchive?.();
  },
  'export-html': (_dispatcher, _target, services) => {
    services.exportHtml?.();
  },
  'export-markdown': (_dispatcher, _target, services) => {
    services.exportMarkdown?.();
  },
  'export-entry-docx': (dispatcher, target, services) => {
    // ⚠ 解決規則は `export-entry` と**同じ**にする(隣に並ぶボタンなので、
    //    片方だけ `selectedLid` 固定だと「A を Word にして B を消す」が成立する)
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry')
      ?? dispatcher.getState().selectedLid;
    if (lid) services.exportEntryDocx?.(lid);
  },
  'export-entry': (dispatcher, target, services) => {
    // ⚠ 解決規則は `delete-entry` と**同じ**にする(review M-3)── 隣に並べる
    // ボタンなので、片方だけ `selectedLid` 固定だと filer / sidebar の行に
    // 並べた瞬間に「A を書き出して B を削除する」が成立する
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.exportEntry?.(lid);
  },
  'purge-orphan-assets': (_dispatcher, _target, services) => {
    services.purgeOrphanAssets?.();
  },
  'import-file': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="import-input"]')
      ?.click();
  },
  // ── P5b: 履歴 / ゴミ箱 ──
  'show-history': (dispatcher) => {
    // 🔴 **無言で断らない**(P8 段⑲)── `SHOW_HISTORY` は `phase !== 'ready'` で
    //    何も返さず、押しても panel も理由も出なかった
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから履歴を開いてください',
      });
      return;
    }
    dispatcher.dispatch({ type: 'SHOW_HISTORY' });
  },
  'hide-history': (dispatcher) => dispatcher.dispatch({ type: 'HIDE_HISTORY' }),
  'restore-revision': (dispatcher, target) => {
    // 前進変異(復元前に現状が履歴に積まれる)なので confirm は要らない ──
    // 「復元の取り消し」も履歴から戻れる
    const revId = target.getAttribute('data-pkc-rev-id');
    if (revId) dispatcher.dispatch({ type: 'RESTORE_REVISION', revId });
  },
  'write-back-file': (dispatcher, target, services) => {
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.writeBackFile?.(lid);
  },
  'show-trash': (dispatcher) => dispatcher.dispatch({ type: 'SHOW_TRASH' }),
  'hide-trash': (dispatcher) => dispatcher.dispatch({ type: 'HIDE_TRASH' }),
  'restore-trash': (dispatcher, target) => {
    const revId = target.getAttribute('data-pkc-rev-id');
    const entryLid = target.getAttribute('data-pkc-trash-lid');
    if (revId && entryLid)
      dispatcher.dispatch({ type: 'RESTORE_TRASH', entryLid, revId });
  },
  'purge-trash': (dispatcher) => {
    // 一括・不可逆(revision の物理削除)なので fail closed(purge-orphan-assets
    // と同じ倒し方 ── 単発 delete-entry の ?? true とは桁が違う)
    const ok = confirmOrExplain(
      dispatcher,
      'ゴミ箱を空にします(削除済み entry の履歴も消え、元に戻せません)。よろしいですか?',
      false,
    );
    if (ok) dispatcher.dispatch({ type: 'PURGE_TRASH' });
  },
};

/**
 * 近道のキー。⚠ **書式パネルに在る操作だけ**を割り当てる ── ここにしか無い
 * 操作を作ると「キーを知っている人にしかできないこと」が生まれる。
 */
/**
 * 🔴 **コマンド id → 書式**(#256)。直す前はここが `{b,i,k}` = **キーの綴り**だったので、
 * 割当を変えると書式が引けなくなった ── **割当は `features/keymap.ts` の表が正本**で、
 * ここが持つのは「そのコマンドが何をするか」だけである。
 */
/**
 * 🔴 **近道は「ボタンをそのまま押す」**(#197 で確立した作法の一般化)。
 * ⚠ 同じ操作が 2 通りの経路を持たない ── 押しボタン側の断り(編集中は無効 等)や
 * 「もう一度押したら戻る」が、鍵からも**同じように**効く。
 * ⚠ ボタンが無い面では**何も起きない**(`preventDefault` もしない = ブラウザに譲る)。
 */
/**
 * PKC の中の D&D で運ぶ型(#240 段④)。⚠ **OS からの file 受けと見分ける**ための
 * 独自 mime ── `Files` を見る既存の経路(添付 / 本文への貼付)に一切触らせない。
 */
const PKC_DRAG = 'application/x-pkc-lids';

const SHORTCUT_BUTTON: Readonly<Record<string, string>> = {
  'create-entry': '[data-pkc-field="create-run"]',
  'edit-entry': '[data-pkc-action="start-edit"]',
  'toggle-replace': '[data-pkc-action="toggle-replace"]',
  'toggle-sidebar': '[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]',
  'toggle-inspector': '[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]',
  'view-query': '[data-pkc-action="set-view"][data-pkc-view="query"]',
  'view-dual': '[data-pkc-action="set-view"][data-pkc-view="dual"]',
  'open-settings': '[data-pkc-action="set-view"][data-pkc-view="settings"]',
  'open-flags': '[data-pkc-action="set-view"][data-pkc-view="flags"]',
  'open-help': '[data-pkc-action="set-view"][data-pkc-view="help"]',
};

const FORMAT_OF: Readonly<Record<string, FormatOp>> = {
  'format-bold': 'bold',
  'format-italic': 'italic',
  'format-link': 'link',
};

function isEditorBody(el: EventTarget | null): el is HTMLTextAreaElement {
  return (
    el instanceof HTMLTextAreaElement &&
    el.getAttribute('data-pkc-field') === 'editor-body'
  );
}

export function bindActions(
  root: HTMLElement,
  dispatcher: Dispatcher,
  services: BinderServices = {},
  /**
   * 🔴 **キーの割当**(#256)。既定はアプリ共有の 1 個。
   * ⚠ **test は自分で `new KeymapStore(...)` して渡す**(`appEditorMode` と同じ作法)──
   *   共有の 1 個を書き換えると、別の test に割当が漏れる。
   */
  keymap: KeymapStore = appKeymap,
  /**
   * 🔴 **「開く」で編集に入るか**(user 裁定 2026-08-18)。既定はアプリ共有の 1 個。
   * ⚠ **test は自分で `new OpenInEditStore(...)` して渡す**(`keymap` と同じ作法)──
   *   共有の 1 個を書き換えると、別の test に設定が漏れる。
   */
  openInEdit: OpenInEditStore = appOpenInEdit,
): () => void {
  /**
   * action を 1 本の口から回す。⚠ **ここを通さない呼び方をしない** ──
   * 実行中(書出し / 取込)のガードはここに 1 回だけ置く(P8 段㉑)。
   * 入口ごとに書くと、必ずどれかが素通しになる(実際そうだった)。
   */
  const run = (action: string | null, el: HTMLElement): void => {
    if (!action) return;
    const handler = ACTIONS[action];
    if (!handler) return;
    if (refuseWhileBusy(action, dispatcher, services)) return;
    handler(dispatcher, el, services, root);
  };
  const onClick = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    if (!el || !root.contains(el)) return;
    /**
     * 🔴 **アプリ内リンクは、ブラウザに遷移させない**(2026-08-08)。
     *
     * 本文の `[題名](entry:<lid>)` は `<a href="entry:…">` として出る
     * (`markdown-render.ts`)。ここは `preventDefault` を呼んでいなかったので、
     * ⚠ **押すとブラウザが未知スキームへの遷移を試みる**。`asset:` の枝だけは
     * 焼く側で href を剥がして避けていた ── **対称の反対側が放置されていた**。
     *
     * 🔑 **href を剥がす側では直さない**。剥がすと `<a>` が**フォーカスできなく
     * なり**、キーボードの動線が落ちる(= 記法を減らすのと同じ向き)。
     * ⚠ **`<a href>` に限る** ── checkbox(`set-flag` / `set-notices-enabled`)で
     *   呼ぶと**チェック状態が巻き戻る**。`data-pkc-action` を持つ `<a href>` は
     *   アプリ内リンクしか無い(`download-asset` は href を剥がしてある /
     *   目次・脚注は action を持たない)。
     */
    if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) ev.preventDefault();
    /**
     * 🔴 **修飾つきのクリックは「印を付ける」**(#240 段②。user 指示 2026-08-17
     * 「複数選択・範囲選択」)。
     *
     * ⚠ 行を選ぶ操作(`select-entry`)にだけ効かせる ── ボタンやリンクで
     * `Ctrl` クリックを奪うと、ブラウザの「新しいタブで開く」を壊す。
     * ⚠ **中央は開き直さない**(印を付けただけで本文が入れ替わらない)。
     * ⚠ `Shift` は**表示順**で範囲を採る(規則は reducer の `filerRows` 1 か所)。
     */
    const me = ev as MouseEvent;
    /**
     * 🔴 **フォルダ面の中だけ**(着地前レビュー 4)。`select-entry` は 6 か所に在る
     * (sidebar / filer / kanban / calendar / query / inspector)ので、面で切らないと:
     * - 一覧タブの `Ctrl` クリックが**画面に出ない印**を増やす(帯だけが数える)
     * - `Shift` の範囲は `filerRows` の並びで採るので、**目で見た並びと違う集合**になる
     *   (フォルダの中の行なら `[]` になり、`preventDefault` 済みなので**選択すら起きない**)
     * - inspector の「関連へ飛ぶ」ボタンで `Ctrl` クリックが奪われる
     * 段②③④は**フォルダ面の機能**である(設計 doc §3)。
     */
    const inFiler = el.closest('[data-pkc-region="filer-table"]') !== null;
    /**
     * 🔴 **2 ペインの行も同じ作法**(#241 段⑥-a)── `Ctrl` / `Cmd` で足し外し、
     * `Shift` で表示順の範囲。⚠ 面ごとに違う選び方を作らない(user は 1 つの
     * ファイラだと思って触る)。
     * ⚠ 側は**押した行**から辿る(`dualSide`)── state の焦点から推測しない。
     */
    if (
      el.getAttribute('data-pkc-action') === 'dual-row' &&
      (me.ctrlKey || me.metaKey || me.shiftKey)
    ) {
      const side = dualSide(el);
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (side !== null && lid !== null) {
        ev.preventDefault();
        dispatcher.dispatch({
          type: 'DUAL_SELECT',
          side,
          lid,
          mode: me.shiftKey ? 'range' : 'toggle',
        });
        return;
      }
    }
    if (
      inFiler &&
      el.getAttribute('data-pkc-action') === 'select-entry' &&
      (me.ctrlKey || me.metaKey || me.shiftKey)
    ) {
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (lid !== null) {
        ev.preventDefault();
        dispatcher.dispatch(
          me.shiftKey ? { type: 'SELECT_RANGE', lid } : { type: 'TOGGLE_SELECT', lid },
        );
        return;
      }
    }
    const action = el.getAttribute('data-pkc-action');
    // ⚠ 行を素で押したときだけ「もう一度押した」を数える(修飾つきは印の話)
    // ⚠ **フォルダ面の中だけ**(上と同じ理由 ── 一覧タブで 2 回押すと、
    //    見えていない現在地が動いて「+ ノート」の作り先だけが変わる)
    if (inFiler && action === 'select-entry') {
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (lid !== null) maybeEnterFolder(lid);
    }
    // ⚠ 2 ペインも**同じ 2 クリック**でフォルダへ入る(規則は 1 本 ── ただし
    //    入る先はそのペインなので、撃つ action だけが違う)
    if (action === 'dual-row') {
      const side = dualSide(el);
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (side !== null && lid !== null) maybeEnterFolder(lid, side);
    }
    run(action, el);
  };
  /**
   * ⚠ 書式パネルのボタンは **focus を奪わない**。奪うと押すたびに編集欄が
   * focus を失って画面がちらつく(選択位置自体は残るので壊れはしない)。
   */
  const onMousedown = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-action]');
    if (el?.getAttribute('data-pkc-action') === 'format-text') ev.preventDefault();
  };
  const onInput = (ev: Event) => {
    if (isEditorBody(ev.target)) {
      dispatcher.dispatch({ type: 'UPDATE_OPEN_BODY', body: ev.target.value });
      return;
    }
    // 🔑 一覧の絞り込み(P7b 段⑨c)。⚠ **state に写す** ── renderer は
    // DOM から値を読まない、というこのリポジトリの規約
    const el = ev.target;
    if (
      el instanceof HTMLInputElement &&
      el.getAttribute('data-pkc-field') === 'entry-filter'
    ) {
      dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: el.value });
    }
  };
  const onChange = (ev: Event) => {
    const el = ev.target;
    // 🔑 `<select>` は click ではなく change で決まる ── 配色のように
    // 「選んだ瞬間に効く」ものはここで拾う(P8)
    if (el instanceof HTMLSelectElement) {
      const action = el.getAttribute('data-pkc-action');
      run(action, el);
      return;
    }
    if (!(el instanceof HTMLInputElement)) return;
    // 🔑 チェックボックス / テキスト欄も **change で確定**する(P8 段⑭)。
    //    ⚠ `input` ごとに撃たない ── グループ名を 1 文字打つたびに disk へ
    //    書き戻すことになる(欄を離れた時・Enter を押した時が確定)
    const changeAction = el.getAttribute('data-pkc-action');
    if (changeAction !== null && changeAction.startsWith('set-app-')) {
      run(changeAction, el);
      return;
    }
    if (changeAction === 'toggle-app-tile') {
      run(changeAction, el);
      return;
    }
    const field = el.getAttribute('data-pkc-field');
    if (field === 'attach-input') {
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.attachFiles?.(files);
    } else if (field === 'import-input') {
      // ⚠ 添付と同じく**全件**渡す ── md は複数選択できる(1 件ずつ entry に
      // なる)。PKC2 の書出しが複数来たときに断るのは import-file.ts の仕事で、
      // ここで 1 件目だけ拾って黙って落とさない
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.importFiles?.(files);
    } else if (field === 'office-pack-input') {
      // ⚠ **1 件だけ**(一式は zip 1 本)。複数選ばれても先頭で決める ──
      //    2 本目を黙って捨てるのではなく、そもそも 1 本しか意味を持たない
      const file = el.files?.[0] ?? null;
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (file) services.installOfficePackFromFile?.(file);
    }
  };
  const onKeydown = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    // editor の 2 field(本文 textarea / title input)でのみ有効
    const field =
      ke.target instanceof HTMLElement
        ? ke.target.getAttribute('data-pkc-field')
        : null;
    // 🔴 IME ガード(PKC2 repo 慣行)── 変換中の Esc は「変換の取り消し」で
    // あって編集キャンセルではない。ガードが無いと draft 丸ごと破棄になる。
    // ⚠ **追記欄より先に置く** ── 変換確定の Enter で送ってしまうと、
    // 日本語で書く人は「打ち終わる前に飛ぶ」を毎回踏む
    if (ke.isComposing) return;
    /**
     * 🔴 **`role="link"` のものは Enter / Space で押せる**(2026-08-08)。
     *
     * `@card` の placeholder は `<span role="link" tabindex="0">` で出る
     * (`markdown-render.ts`)── ⚠ 直す前はこの下の `data-pkc-field` の門で
     * **必ず抜けていた**ので、**フォーカスできるのに Enter が効かない**要素が
     * 存在していた(user 指示「マウスだけで完結し、キーボードは近道」の破れ)。
     *
     * ⚠ **`data-pkc-field` の門より前**に置く(placeholder は field を持たない)。
     * ⚠ `<button>` / `<a>` はブラウザ既定で Enter → click に乗るので**対象外**。
     *
     * 🔴 **拾うのは `tabindex="0"`(巡回に入るもの)だけ**(2026-08-18 の着地前
     * レビュー 3)。`hasAttribute('tabindex')` で書いていたので、フォルダの行に
     * `tabindex="-1"` を足した瞬間に**行がこの経路へ入った** ── `-1` は
     * 「焦点を**置ける**」であって「**押せる**」ではないのに、`Space` が
     * `select-entry` を撃つ**登録も設定も説明も無い鍵**になっていた
     * (Ctrl クリックで 5 行に印 → 送ろうと Space → 印が 1 件に潰れる)。
     * ⚠ 行を相手にするのは `filer` 文脈の鍵のほう(下の `runFilerKey`)。
     */
    if (ke.key === 'Enter' || ke.key === ' ') {
      const el = ke.target instanceof HTMLElement ? ke.target : null;
      if (el?.getAttribute('tabindex') === '0' && el.hasAttribute('data-pkc-action')) {
        // ⚠ Space は既定でページを送る ── 押した先が動くほうが正しい
        ke.preventDefault();
        run(el.getAttribute('data-pkc-action'), el);
        return;
      }
    }
    // 追記欄: 既定は Ctrl/Cmd+Enter(欄の中だけ ── 画面全体の近道にしない)
    if (field === 'append-input') {
      if (keymap.match(ke, 'append') === 'append-send') {
        ke.preventDefault();
        run('append-entry', ke.target as HTMLElement);
      }
      return;
    }
    /**
     * 🔴 **live 面の行の入力欄にも書式の近道(Ctrl+B/I/K)を効かせる**(2026-08-08)。
     * 直す前は下の門(editor-body / editor-title)で弾かれて**無言 no-op** だった。
     * ⚠ ここで受けるのは FORMAT_KEYS **だけ** ── Ctrl+S / Esc は行の側
     * (`row-swap.ts`)が「行の確定 / 行の取り消し」として持つ。ここで
     * `COMMIT_EDIT` / `CANCEL_EDIT` を撃つと**編集の面ごと閉じてしまう**(別の操作)。
     */
    if (field === 'row-source') {
      const rowCmd = keymap.match(ke, 'row');
      const rowOp = rowCmd === null ? undefined : FORMAT_OF[rowCmd];
      if (rowOp === undefined) return;
      ke.preventDefault();
      const ta = ke.target as HTMLTextAreaElement;
      writeBack(
        ta,
        applyFormat(
          { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
          rowOp,
        ),
      );
      return;
    }
    if (field !== 'editor-body' && field !== 'editor-title') return;
    // PKC2 慣例: Ctrl/Cmd+S = 保存(ブラウザの保存ダイアログも抑止)、
    // Esc = キャンセル。Ctrl/Cmd+Enter も保存の別名として受ける
    // (PKC2 の章フォーカス編集が両対応だった)。altKey は除外(AltGr = Ctrl+Alt 誤発火)
    // ⚠ 追記(P8 段⑥)は**編集欄そのものを書き換える**ので、PKC2 のように
    // 「追記専用の textarea + Ctrl+Enter で確定」を別に持たない ── 別経路にすると
    // 編集中の draft と競合し、追記した節が保存で黙って消える(PKC2 の実測)
    const cmd = keymap.match(ke, 'editor');
    const op = cmd === null ? undefined : FORMAT_OF[cmd];
    if (cmd === 'commit-edit') {
      ke.preventDefault();
      // ⚠ 近道キーも同じ規則に乗せる(ボタンだけ止めても意味が無い)
      if (refuseWhileBusy('commit-edit', dispatcher, services)) return;
      renameFromEditorInput(dispatcher, root);
      dispatcher.dispatch({ type: 'COMMIT_EDIT' });
    } else if (field === 'editor-body' && op !== undefined) {
      // 🔑 **キーボードは近道**(業務画面の作法 ── user 指示 2026-08-03)。
      // 本文だけ。題名に太字を入れても意味が無い。⚠ `isComposing` は上で弾き済み
      ke.preventDefault();
      const ta = ke.target as HTMLTextAreaElement;
      writeBack(
        ta,
        applyFormat(
          { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
          op,
        ),
      );
    } else if (cmd === 'cancel-edit') {
      ke.preventDefault();
      cancelFromEditor(dispatcher, root);
    }
  };
  /**
   * 🔴 **本文を書く欄**(#250)── 貼った画像を**差し込んでよい**相手。
   *
   * 面ではなく**欄の名前**で見る:`row-source`(1 面)/ `editor-body`(2 列)/
   * `append-input`(継ぎ足し)の 3 つ。⚠ 継ぎ足しの欄は `detail` 面の**外**に在る
   * (`shell.ts` で兄弟)ので、面で見ると**そこだけ落ちる** ── PKC2 は
   * `isMarkdownTextarea` で欄を見ており、継ぎ足しにも貼れていた。
   */
  /**
   * 🔴 **画像かどうかの判定は 1 本**(2026-08-18、着地前レビュー)。
   *
   * ⚠ `f.type` を直に見ると、**MIME を付けない環境**から `.png` を落としたとき
   * 画像に見えない ── 拡張子から引く `resolveMime` を通す(添付の入口と同じ規則)。
   * ⚠ `!` を付けるかの判定は `asset-ref-format.ts` が正本(「この 1 本だけを使う」)。
   */
  const isImageFile = (f: File): boolean => isImageAssetMime(resolveMime(f.name, f.type));

  const BODY_FIELDS = new Set(['row-source', 'editor-body', 'append-input']);
  const isBodyInput = (t: EventTarget | null): t is HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement && BODY_FIELDS.has(t.getAttribute('data-pkc-field') ?? '');

  /**
   * 待っている間に作り直された欄を引き直す。
   * ⚠ **同じ種類の欄へ**戻す(継ぎ足しに貼ったものが本文へ入ると事故)。
   */
  const reResolveInput = (from: HTMLTextAreaElement): HTMLTextAreaElement | null => {
    if (from.isConnected) return from;
    const field = from.getAttribute('data-pkc-field') ?? '';
    if (field === 'append-input')
      return root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    return formatTarget(root);
  };

  /** ⚠ `DataTransfer` から **File だけ**を拾う(`files` が空なら `items` から)。 */
  const filesOf = (dt: DataTransfer | null | undefined): File[] => {
    const out: File[] = [];
    const list = dt?.files;
    if (list && list.length > 0) {
      for (let i = 0; i < list.length; i += 1) {
        const f = list.item(i);
        if (f) out.push(f);
      }
      return out;
    }
    const items = dt?.items;
    if (!items) return out;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]!;
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
    return out;
  };

  /**
   * 🔴 **待ったあとの差し先**(#250 / #251 で共用)。⚠ 待っている間に
   * ① 編集欄が作り直される(live の面は行を組み直す)② 取り消して別のノートを
   * 開き直す ── のどちらも起きるので、**掴んだままの textarea へ差さない**。
   * ⚠ 別のノートを開いていたら `null`(取り消した貼付が別のノートに現れない)。
   */
  const insertTargetAfterAwait = (
    from: HTMLTextAreaElement,
    openedLid: string | null,
  ): HTMLTextAreaElement | null => {
    const sameEdit = (dispatcher.getState().openBody?.lid ?? null) === openedLid;
    return sameEdit ? reResolveInput(from) : null;
  };

  /**
   * 🔴 **画像を本文へ差し込む**(⚠ 待つので、差す先は**あとで引き直す**)。
   */
  const insertPasted = (files: readonly File[], from: HTMLTextAreaElement): void => {
    // ⚠ **どのノートの編集に貼ったか**を控える(2026-08-18、着地前レビュー)──
    //   待っている間に取り消して別のノートを開き直すと、`formatTarget` は
    //   **新しい編集欄**を返す = 取り消したはずの貼付が別のノートに現れる。
    const openedLid = dispatcher.getState().openBody?.lid ?? null;
    void services.pasteImages!(files).then((refs) => {
      // 🔴 **待っている間に編集欄が作り直されることがある**(live の面は行を組み直す)。
      //   掴んだままの textarea へ差すと、**画面に出ていない所へ字を書く** ──
      //   貼付が黙って消えるので、差す直前に**いま在る編集欄**へ引き直す。
      const into = insertTargetAfterAwait(from, openedLid);
      if (!into) {
        // 🔴 **差し先が消えた。**(1 面の編集は、別の欄を触った瞬間に行を確定して
        //   閉じる ── 実ブラウザで実際にそうなる)
        // 🔑 **編集を抜けているなら捨てない** ── 同じ file を添付へ回す。
        //   content addressing なので bytes は二重にならない(鍵が同じ)。
        // ⚠ **まだ編集中なら添付にはできない**(`CREATE_ENTRY` が黙殺される)──
        //   そのときは「もう一度」と言う。クリップボードは残っているので、
        //   これは実際にやり直せる指示である。
        // ⚠ どちらも黙って終わらない ──「貼ったのに出ない」を作らない。
        const ready = dispatcher.getState().phase === 'ready';
        if (ready && services.attachFiles) {
          services.attachFiles([...files]);
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: '編集欄が閉じたため、貼り付けた画像は添付にしました',
          });
        } else {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: '編集欄が閉じたため貼り付けられませんでした。もう一度貼ってください',
          });
        }
        return;
      }
      // ⚠ `execCommand` は**焦点のある要素**に効く ── 待っている間に焦点が
      //   移ることがあるので、差す前に戻す(戻さないと別の所へ入る)。
      into.focus();
      // ⚠ 差し込みは `execCommand('insertText')` ── **undo に載る**
      for (const ref of refs) insertText(into, `${ref}\n`);
    });
  };

  /**
   * 🔴 **貼付 / 落とした file の行き先を決める**(#250)。
   *
   * 行き先は**そこが編集中の本文か**で決まる:
   * - **編集中の本文(textarea)** … 画像は資産にして**その場に参照を差し込む**
   *   (⚠ ノートは作らない ── 編集中は `CREATE_ENTRY` が黙殺される)
   * - **それ以外** … 添付として取り込む(添付ボタンと同じ道)
   *
   * ⚠ **受け手がいなければ `false` を返す**(呼び側は既定を止めない)──
   * 止めると文字の貼付まで死ぬ。
   */
  const routeFiles = (files: readonly File[], target: EventTarget | null): boolean => {
    if (files.length === 0) return false;
    const inBody = isBodyInput(target);
    const images = inBody ? files.filter(isImageFile) : [];
    const rest = files.filter((f) => !images.includes(f));
    let handled = false;
    if (images.length > 0 && services.pasteImages) {
      insertPasted(images, target as HTMLTextAreaElement);
      handled = true;
    }
    // ⚠ 画像**以外**(と、差し込む口が無い環境)は添付へ倒す ── 無反応にしない
    const leftover = images.length > 0 && services.pasteImages ? rest : files;
    if (leftover.length > 0 && services.attachFiles) {
      services.attachFiles([...leftover]);
      handled = true;
    }
    return handled;
  };

  /**
   * 🔴 **文字の貼付**(#251)。2 つのことをする ──
   * ① `text/html` を PKC-Markdown へ戻す ② `data:` / `blob:` を資産へ逃がす。
   *
   * ⚠ **どちらも要らないなら `false`** ── 既定の貼付(text/plain)に委ねる。
   *   止めてしまうと、変換の要らない普通の貼付まで**こちらの都合で書き換わる**。
   * ⚠ 入る先は**本文の欄だけ**(題名や検索欄に markdown を組み立てない)。
   * ⚠ 資産化は待つので、差し先は `insertTargetAfterAwait` で引き直す(#250 と同じ)。
   *
   * @returns 既定の貼付を止めたら `true`
   */
  const pasteText = (ce: ClipboardEvent): boolean => {
    const target = ce.target;
    if (!isBodyInput(target)) return false;
    const html = ce.clipboardData?.getData('text/html') ?? '';
    const plain = ce.clipboardData?.getData('text/plain') ?? '';
    const converted = convertPastedHtml({ html, plain });
    const text = converted ?? plain;
    if (text === '') return false;

    const adopt = services.adoptPastedUrls;
    const urls = adopt ? adoptableUrls(text) : [];
    // 変換もせず、逃がすものも無い ── **何も足せない**ので既定に任せる
    if (converted === null && urls.length === 0) return false;
    // ⚠ 逃がすものが無い(= 資産にする口が無い環境も含む)ときは、その場で差す
    if (urls.length === 0) {
      insertText(target, text);
      return true;
    }

    const from = target;
    const openedLid = dispatcher.getState().openBody?.lid ?? null;
    // ⚠ `urls` は `adopt` が在るときしか埋まらない(上の三項)── `pasteImages!` と同じ形
    void adopt!(urls).then(({ adopted, problems }) => {
      const r = rewriteAdopted(text, adopted);
      const into = insertTargetAfterAwait(from, openedLid);
      if (!into) {
        // ⚠ 黙って終わらない ──「貼ったのに出ない」を作らない。
        //   クリップボードは残っているので、これは実際にやり直せる指示である
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: '編集欄が閉じたため貼り付けられませんでした。もう一度貼ってください',
        });
        return;
      }
      into.focus();
      insertText(into, r.text);
      /**
       * 🔴 **断りは 1 本にまとめる**(検算で判明)。`state.error` は **1 枠**なので、
       * 理由(空き容量)を先に出しても、件数の総括で**上書きされて消える**。
       * ⚠ 理由が在るならそちらを出す ── 件数は「何件残ったか」しか言わないが、
       *   理由は **user が直せる**(容量を空ける)。
       */
      if (problems.length > 0) {
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `貼り付けた画像を保存できませんでした: ${problems[0]!}`,
        });
      } else if (r.failed > 0) {
        // ⚠ 読めなかった宛先は**元のまま残している** ── 消していないことまで言う
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `貼り付けた画像 ${r.failed} 件を読み込めませんでした(元の参照のまま残しています)`,
        });
      }
    });
    return true;
  };

  /**
   * 🔴 **スクショの貼付**(#250。user 指示 2026-08-18「PKC3 でスクショ貼付の導線が
   * ない。PKC2 と同様以上に実装してください」)。
   *
   * ⚠ **画像が無ければ何もしない**(`preventDefault` しない)── 文字の貼付を殺さない。
   * 🔑 PKC2 は**最初の 1 枚**だけ拾っていたが、ここは**クリップボードの画像を全部**拾う。
   */
  const onPaste = (e: Event): void => {
    const ce = e as ClipboardEvent;
    const files = filesOf(ce.clipboardData).filter(isImageFile);
    if (routeFiles(files, ce.target)) {
      ce.preventDefault();
      return;
    }
    if (pasteText(ce)) ce.preventDefault();
  };

  /**
   * 🔴 **OS から落とした file**(#250)。貼付と**同じ行き先**へ流す。
   *
   * ⚠ `dragover` を止めないと `drop` は**来ない**(既定は「受け取らない」)。
   * ⚠ そして止めないと、ブラウザが**その file へ画面ごと遷移する** ──
   *   編集中の本文が消えるので、受け取れなくても**止めるほうが安全**である。
   */
  const onDragOver = (e: Event): void => {
    const de = e as DragEvent;
    // 🔴 **PKC の中の移動**(#240 段④)── OS からの file 受けとは**別の型**で見分ける
    if (de.dataTransfer?.types?.includes(PKC_DRAG) === true) {
      const drop = dropTargetOf(de.target);
      if (drop === undefined) {
        // ⚠ **光ったままにしない**(着地前レビュー 5)── フォルダの上を通ってから
        //    別の行で離すと、user は「そこへ入った」と読む(実際は何も動かない)
        clearDropTarget();
        return; // 落とせない場所 ── 既定(受け取らない)のまま
      }
      e.preventDefault();
      de.dataTransfer.dropEffect = 'move';
      markDropTarget(drop.el);
      return;
    }
    if (de.dataTransfer?.types?.includes('Files') !== true) return;
    e.preventDefault();
    if (de.dataTransfer) de.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: Event): void => {
    const de = e as DragEvent;
    if (de.dataTransfer?.types?.includes(PKC_DRAG) === true) {
      const drop = dropTargetOf(de.target);
      clearDropTarget();
      if (drop === undefined) return;
      e.preventDefault();
      const lids = (de.dataTransfer.getData(PKC_DRAG) || '').split(' ').filter((x) => x !== '');
      moveDropped(lids, drop.lid);
      return;
    }
    const files = filesOf(de.dataTransfer);
    if (files.length === 0) return;
    // ⚠ 受け手がいなくても止める(上の理由 ── 遷移で編集が飛ぶ)
    e.preventDefault();
    routeFiles(files, de.target);
  };
  /**
   * 🔴 **掴んだものを運ぶ**(#240 段④)。
   * ⚠ 掴んだ行に**印が付いていれば印ごと**運ぶ(付いていなければその 1 件だけ)──
   *   「選んだつもりの物と動く物が違う」を作らない。
   */
  const onDragStart = (e: Event): void => {
    const de = e as DragEvent;
    const row = (de.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-entry]');
    const lid = row?.getAttribute('data-pkc-entry') ?? null;
    if (lid === null || !de.dataTransfer) return;
    const st = dispatcher.getState();
    /**
     * 🔴 **掴んだ面の印を運ぶ**(#273 段⑤)。⚠ 2 ペインから掴んだのに**左の列**の
     * 印を運ぶと、**画面に出ていないものが動く**(移す・写す・消すと同じ罠)。
     */
    const side = row ? dualSide(row) : null;
    const marked =
      side === null
        ? visibleSelection(visibleFilerRows(st), st.selection)
        : visibleSelection(
            filerRows(paneScope(paneOf(st.dual, side)), st.entryMetas, st.relations, {
              filterQuery: st.filterQuery,
              searchHits: st.searchHits,
              sort: st.entrySort,
            }),
            paneOf(st.dual, side).selection,
          );
    const lids = marked.includes(lid) ? marked : [lid];
    de.dataTransfer.setData(PKC_DRAG, lids.join(' '));
    de.dataTransfer.effectAllowed = 'move';
  };
  const onDragEnd = (): void => clearDropTarget();
  /** 落とし先(フォルダの行 / パンくずの段)。`undefined` = 落とせない場所。 */
  const dropTargetOf = (target: EventTarget | null): { el: HTMLElement; lid: string | null } | undefined => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-drop]');
    if (!el || !root.contains(el)) return undefined;
    /**
     * ⚠ **ペインの地は「そのペインが開いている場所」へ落ちる**(#273 段⑤)。
     * `data-pkc-entry` を持たせると**ペイン自身が entry** に見えるので、
     * 行き先は別の属性で渡す。⚠ 空文字はルート(属性が**無い**のとは別物)。
     */
    const scope = el.getAttribute('data-pkc-drop-scope');
    if (scope !== null) return { el, lid: scope === '' ? null : scope };
    // ⚠ パンくずのルートは `data-pkc-entry` を持たない = 出す先(ルート)
    return { el, lid: el.getAttribute('data-pkc-entry') };
  };
  let dropMark: HTMLElement | null = null;
  const markDropTarget = (el: HTMLElement): void => {
    if (dropMark === el) return;
    clearDropTarget();
    dropMark = el;
    el.setAttribute('data-pkc-dropping', '');
  };
  const clearDropTarget = (): void => {
    dropMark?.removeAttribute('data-pkc-dropping');
    dropMark = null;
  };
  /**
   * 落としたものを動かす。⚠ **断る理由を出す**(無言の操作拒否を作らない)──
   * フォルダを自分の子孫へ落とす等、reducer が黙って捨てる形が在る。
   */
  const moveDropped = (lids: readonly string[], parentLid: string | null): void =>
    moveEntries(dispatcher, lids, parentLid, services.showStatus);
  /**
   * 🔴 **フォルダは 2 クリックで開く**(#240 段①。user 指示 2026-08-17
   * 「フォルダをダブルクリックで開くように変更」)。
   *
   * ⚠ **ネイティブの `dblclick` に頼らない。** ブラウザは「同じ node を 2 回」
   * 押したときにしか `dblclick` を出さないので、**2 回のクリックの間に行が
   * 作り直されると出ない** ── この面は保存の ack や別タブの更新で表を組み直すので、
   * 実 user も「開かない」を踏む(実ブラウザ smoke で実際に落ちた)。
   * 🔑 だから**同じ lid への連続押し**で見る ── node が入れ替わっても lid は同じ。
   * ⚠ 1 クリック目(= 選ぶ)は `onClick` が撃っている。ここは**現在地だけ**動かす。
   * ⚠ フォルダ以外では何もしない(ノートを 2 回押しても入る先が無い)。
   */
  const DOUBLE_MS = 500;
  /**
   * 🔴 **鍵に「どの面で押したか」を入れる**(着地前レビュー R3)。
   * ⚠ 呼び手は 1 つ(左の列)から **3 つ**(左の列 / 2 ペインの左 / 右)に増えた。
   *   `lid` だけを鍵にすると、**別々の面での 1 回ずつ**が「もう一度押した」に化ける
   *   ── 起動時は左右ともルートなので**同じフォルダが両方の表に出ており**、
   *   左で選んで右で選ぶと、印を付けたかっただけの右が中へ入る。
   */
  let lastRowClick: { key: string; at: number } = { key: '', at: 0 };
  const maybeEnterFolder = (lid: string, dual: DualSide | null = null): void => {
    const key = `${dual ?? 'filer'}:${lid}`;
    const now = Date.now();
    const again = lastRowClick.key === key && now - lastRowClick.at <= DOUBLE_MS;
    lastRowClick = { key, at: now };
    if (!again) return;
    if (dispatcher.getState().entryMetas.get(lid)?.archetype !== 'folder') return;
    lastRowClick = { key: '', at: 0 }; // 3 回目を「もう一度」と数えない
    // ⚠ **入る先はその面の現在地** ── 2 ペインで `SET_SCOPE` を撃つと、
    //    押していない左の列が動いて、押した側は 1 ミリも動かない
    dispatcher.dispatch(
      dual === null
        ? { type: 'SET_SCOPE', lid }
        : { type: 'DUAL_SET_SCOPE', side: dual, lid },
    );
  };
  root.addEventListener('click', onClick);
  root.addEventListener('paste', onPaste);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragend', onDragEnd);
  root.addEventListener('mousedown', onMousedown);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  /**
   * 🔑 **画面全体の近道**(P10)。いまは `Ctrl/Cmd+N` = いま選んでいる種類で作る
   * (user 指示「追加ボタンと ctrl+n の対象を更新」)。
   *
   * 🔴 **document で受ける** ── `root` に付けると、focus が root の外(`body` 等)に
   * あるときに届かない。編集をやめた直後は focus が消えた要素から body へ落ちるので、
   * **そこで効かない近道**になっていた(実測で落ちた)。
   * ⚠ `root` が外れていたら何もしない ── test が root を作り直しても、
   * 古い binder の handler が生き残って二重に作らないため。
   * ⚠ 編集中の欄では受けない(打っている途中に別のノートへ飛ぶのは事故)。
   * ⚠ `altKey` を除く(AltGr = Ctrl+Alt の誤発火)。
   * ⚠ ブラウザの「新しいウィンドウ」を止める(`preventDefault`)。
   */
  const onShortcut = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.isComposing || !root.isConnected) return;
    const el = ke.target instanceof HTMLElement ? ke.target : null;
    /**
     * 🔴 **打っている欄は「名前」ではなく「構造」で見る**(着地前レビュー 4)。
     *
     * ⚠ 直す前は `data-pkc-field` の名指し 4 つ + `contenteditable` だった ──
     * **実在する入力欄を 6 つ数え落として**いた(絞り込み `entry-filter` /
     * 置換の 2 欄 / 関係の相手 / アプリの分類・図案)。絞り込みに語を打っている
     * 最中の `Ctrl+E` で**編集に入って面が変わる**、`Alt+2` で集計へ飛ぶ、が起きる。
     * ⚠ 名指しの表は「欄が増えるたびに直す」形で、**増やした人は気づけない**。
     * 🔑 `<textarea>` / 文字を打つ `<input>` / `contenteditable` を構造で拾う。
     * ⚠ `button` / `checkbox` / `radio` / `file` / `submit` は**打つ欄ではない**
     *   (押しボタンに焦点があるときまで近道を止めると、キーボードだけの動線が死ぬ)。
     */
    const typing =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement &&
        !/^(button|checkbox|radio|file|submit|reset|image)$/.test(el.type)) ||
      el?.isContentEditable === true;
    /**
     * 🔴 **フォルダの表の中は、別の文脈**(user 裁定 2026-08-18「OS のファイラ動作に
     * 似せる方向で平仄も合わせて」)。⚠ **行に焦点があるときだけ**効かせる ──
     * 面をまたいで効かせると、#240 の着地前レビューで踏んだ
     * 「見えない所で印が増える / 現在地が動く」を繰り返す。
     */
    /**
     * ⚠ **打っている最中は、面の文脈キーを走らせない**。
     * ⚠ いまの面には入力欄が 1 つ(名前の打ち替え)しか無く、**それは下の枝が先に
     *   受ける**ので、この門は**変異試験で観測できない**(外しても test は全部通る)。
     *   将来この面に入力欄が増えたときのための備えとして置いている ── 「これが
     *   無いと壊れる」とは書かない(CLAUDE.md「外して壊れることを 1 度は見る」)。
     */
    if (!typing && el?.closest('[data-pkc-region="filer-table"]')) {
      const fcmd = keymap.match(ke, 'filer');
      if (fcmd !== null && runFilerKey(fcmd)) {
        ke.preventDefault();
        return;
      }
    }
    /**
     * 🔴 **2 ペインの中も、同じ鍵が効く**(#273)。⚠ 行き先だけが違う ──
     * `state.scopeLid` ではなく `state.dual` の、**焦点のあるペイン**に効く。
     */
    const dualHost = el?.closest<HTMLElement>('[data-pkc-region="dual-pane"]');
    /**
     * 🔴 **名前を打ち替えている欄の鍵は、ここで完結させる**(#273 段④)。
     * `Enter` で確定、`Esc` でやめる。⚠ それ以外の鍵は**入力へ通す**(打てなくなる)。
     */
    if (dualHost && el instanceof HTMLInputElement && el.matches('[data-pkc-field="dual-rename"]')) {
      const lid = el.getAttribute('data-pkc-entry');
      if (ke.key === 'Enter' && lid !== null) {
        ke.preventDefault();
        commitDualRename(lid, el.value);
        return;
      }
      if (ke.key === 'Escape') {
        ke.preventDefault();
        dispatcher.dispatch({ type: 'DUAL_RENAME_END' });
        return;
      }
      return;
    }
    if (!typing && dualHost) {
      const dside0 = dualHost.getAttribute('data-pkc-side');
      /**
       * 🔴 **F2 で名前を打ち替える**(OS のファイラ / FD と同じ鍵)。
       * ⚠ 行に焦点があるときだけ(帯やボタンの上では出さない)。
       */
      if (ke.key === 'F2' && (dside0 === 'left' || dside0 === 'right')) {
        const lid = focusedDualLid(dside0) ?? paneOf(dispatcher.getState().dual, dside0).selection[0];
        if (lid !== undefined && lid !== null) {
          ke.preventDefault();
          dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side: dside0, lid });
          return;
        }
      }
      const dside = dualHost.getAttribute('data-pkc-side');
      /**
       * 🔴 **Tab は反対のペインへ**(FD / OS のファイラの基本操作)。
       * ⚠ **行に焦点があるときだけ**奪う ── タブの帯やボタンに居るときまで奪うと、
       *   キーボードで面から出られなくなる(閉じ込め)。
       */
      if (
        ke.key === 'Tab' &&
        !ke.ctrlKey &&
        !ke.metaKey &&
        !ke.altKey &&
        (dside === 'left' || dside === 'right') &&
        el?.closest('[data-pkc-action="dual-row"]')
      ) {
        const to = otherSide(dside);
        ke.preventDefault();
        dispatcher.dispatch({ type: 'DUAL_FOCUS', side: to });
        const st = dispatcher.getState();
        const lid = paneOf(st.dual, to).selection[0] ?? dualRows(st, to)[0]?.lid ?? null;
        if (lid !== null) dualRowEl(to, lid)?.focus();
        return;
      }
      const dcmd = keymap.match(ke, 'filer');
      if ((dside === 'left' || dside === 'right') && dcmd !== null && runDualKey(dcmd, dside)) {
        ke.preventDefault();
        return;
      }
    }
    const cmd = keymap.match(ke, 'global');
    if (cmd === null) return;
    /**
     * 打鍵中に効かせてよいか。**コマンドが名乗る** + **その和音が文字を打たない**の
     * 両方が要る(着地前レビュー 2)── `open-help` は `F1` のために名乗っているが、
     * 別名の `Alt+5` は mac で `∞` を打つ鍵である。名乗りだけを見ると、
     * **本文に記号が入らずヘルプが開く**。
     */
    const chord = chordOf(ke);
    if (typing && !(findCommand(cmd)?.whileTyping === true && chord !== null && !typesCharacter(chord)))
      return;
    if (cmd === 'nav-back' || cmd === 'nav-forward') {
      ke.preventDefault();
      dispatcher.dispatch({ type: 'NAV_HISTORY', dir: cmd === 'nav-back' ? 'back' : 'forward' });
      return;
    }
    if (cmd === 'view-detail') {
      // ⚠ 本文の面には押しボタンが無い(既定の面なので)── ここだけ dispatch する
      if (dispatcher.getState().viewMode === 'detail') return;
      ke.preventDefault();
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
      return;
    }
    if (cmd === 'toggle-focus-mode') {
      /**
       * 🔑 **両側を一度に畳む / 戻す**(PKC2 のフォーカスモード相当)。
       * ⚠ 押しボタン 2 つを続けて押す実装にしない ── 片方だけ畳まれている状態から
       *   押すと**入れ替わる**だけで、user が期待する「集中」にならない。
       */
      const next = appPanes.getHidden().length === PANES.length ? [] : [...PANES];
      ke.preventDefault();
      applyPaneVisibility(root, appPanes.setHidden(next));
      return;
    }
    if (cmd === 'focus-search') {
      const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]');
      if (!input) return; // 欄が無い面では何も起きない(ブラウザの検索に譲る)
      ke.preventDefault();
      input.focus();
      input.select();
      return;
    }
    const sel = SHORTCUT_BUTTON[cmd];
    if (sel === undefined) return;
    const btn = root.querySelector<HTMLElement>(sel);
    if (!btn) return;
    ke.preventDefault();
    btn.click();
  };
  /**
   * 🔴 **整理の面の鍵**(user 裁定 2026-08-18)。⚠ **既にある動線を呼ぶだけ**にする ──
   * ここで別の実装を書くと、押しボタンと鍵で結果が違う形になる(CLAUDE.md §7)。
   * @returns 効いたら true(呼び側が既定を止める)
   */
  /**
   * 🔴 **焦点の面倒は「描く側」が 1 か所で見る**(2026-08-18。実ブラウザで実測)。
   *
   * ⚠ ここに「dispatch のあとに 1 行目へ置き直す」を書いていたが**足りなかった**
   * ── 表を丸ごと組み直すのは renderer なので、**そのあとに来る別の再描画**
   * (本文の読み込み完了など)で焦点がまた `body` へ落ちる。中身のあるフォルダへ
   * 入る smoke が、まさにそれで落ちた(焦点は `body` に在った)。
   * 🔑 **壊す側が直す** ── `filer.ts` が組み直しの前後で焦点を持ち越す。
   *   binder は「どこへ移るか」だけを決め、焦点には触らない
   *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
   */

  /**
   * 🔴 **いま焦点の枠が乗っている行**(2026-08-18 の着地前レビュー 2)。
   *
   * ⚠ `selectedLid`(= 中央に開いているノート)と**別物**である。フォルダへ
   * 入ると `SET_SCOPE` が印を外し、`filer.ts` が 1 行目へ**焦点だけ**
   * 持ち越す ── このとき `selectedLid` は**入る前に押した行のまま**なので、
   * 直す前は「もう一度 Enter」が**同じフォルダを開き直そうとして無言で終わって**
   * いた(reducer が `scopeLid === action.lid` を弾く)。⚠ user から見ると
   * 「枠は次の行に見えているのに Enter が効かない」。
   * 🔑 **進む操作は焦点に従い、壊す操作は印を要る**(誤差の向きを決める)──
   *   `filer-trash` はここを使わない(焦点は自動で乗るので、押していない行が
   *   ゴミ箱へ入る道を作らない)。
   */
  const focusedRowLid = (): string | null => {
    const el = root.ownerDocument.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const tr = el.closest('[data-pkc-region="filer-table"] [data-pkc-entry]');
    return tr?.getAttribute('data-pkc-entry') ?? null;
  };

  /** 表の中のその行(`data-pkc-entry` は user 由来ではないが、選択子に埋めない)。 */
  const rowEl = (lid: string): HTMLElement | null =>
    Array.from(
      root.querySelectorAll<HTMLElement>('[data-pkc-region="filer-table"] [data-pkc-entry]'),
    ).find((el) => el.getAttribute('data-pkc-entry') === lid) ?? null;

  const focusRow = (lid: string): void => rowEl(lid)?.focus();

  /**
   * 🔴 **行送りの行き先**(user 裁定 2026-08-18「行送りに上下キーを使う」)。
   *
   * ⚠ 並びは **`filerRows` 1 か所**から採る(描く側・範囲選択と同じ答え)──
   * DOM の並びを読むと、絞り込みや並べ替えのときに**目で見た順と食い違う**。
   * ⚠ 焦点がまだ無いときは、下向きなら先頭・上向きなら末尾から入る(OS と同じ)。
   * ⚠ 端では**止まる**(巻き戻さない)── 一覧の端で押し続けると反対側へ飛ぶのは
   *   OS のファイラの挙動ではない。
   */
  const rowAt = (st: AppState, delta: number): string | null => {
    const rows = visibleFilerRows(st);
    if (rows.length === 0) return null;
    const cur = focusedRowLid();
    const i = cur === null ? -1 : rows.findIndex((m) => m.lid === cur);
    if (i === -1) return (delta > 0 ? rows[0] : rows[rows.length - 1])?.lid ?? null;
    return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]?.lid ?? null;
  };

  /**
   * 🔴 **ノートを「開く」**(user 裁定 2026-08-18)。
   *
   * > 「**Enter は閲覧を開始、インライン編集で常に開くは設定でトグル可能にすること**」
   *
   * 既定は**閲覧**: 中央にそのノートを開き、本文の面へ焦点を移す(読み進めと
   * スクロールがそのままキーボードで続く)。設定が ON のときだけ、**本文が届いてから**
   * 編集に入る。⚠ `START_EDIT` は `openBody` が揃っていないと**黙って何もしない**
   * ので、その場で撃つと「設定を入れたのに編集にならない」になる。
   */
  const openNote = (lid: string): boolean => {
    if (!selectEntryOrExplain(dispatcher, lid, 'ノート')) return false;
    root.querySelector<HTMLElement>('[data-pkc-region="detail"]')?.focus();
    if (openInEdit.enabled()) startEditWhenReady(lid);
    return true;
  };

  /**
   * 本文が届いたら 1 回だけ編集に入る。
   * ⚠ **あきらめる条件を必ず持つ**(CLAUDE.md「短命購読は teardown で必ず外す」)──
   * 別のノートへ移ったとき / `ready` を離れたときは購読を外す。持たないと、
   * user が自分で編集して確定した瞬間に**もう一度勝手に編集へ入る**。
   */
  const startEditWhenReady = (lid: string): void => {
    const arrived = (s: AppState): boolean => s.openBody?.lid === lid;
    if (arrived(dispatcher.getState())) {
      dispatcher.dispatch({ type: 'START_EDIT' });
      return;
    }
    const off = dispatcher.onState((s) => {
      if (s.selectedLid !== lid || s.phase !== 'ready') {
        off();
        return;
      }
      if (!arrived(s)) return;
      off();
      dispatcher.dispatch({ type: 'START_EDIT' });
    });
  };

  /**
   * 🔴 **2 ペインをキーボードで動かす**(#273。user 指摘 2026-08-19
   * 「OS のファイラと同じことができないといけません / 往年の FD などを見習って」)。
   *
   * ⚠ 直す前、2 ペインは**キーボードで 1 ミリも動かなかった** ── `filer-*` の 8 命令は
   *   `runFilerKey` が `state.scopeLid` / `state.selection` を見るので**左の列にだけ**
   *   効き、`state.dual` には 1 つも届いていなかった(開く `view-dual` だけが割当)。
   * 🔑 **命令を増やさない**(`dual-*` を別に作らない)── 増やすと user は同じ操作を
   *   2 回割り当て直すことになる。**同じ鍵が、焦点のある面に効く**形にする。
   * 🔑 並びは `filerRows` **1 か所**から採る ── 描く側(`dual-filer.ts`)・
   *   範囲選択(reducer)と同じ答えでないと、目で見た順と食い違う。
   */
  const dualRows = (st: AppState, side: DualSide): EntryMeta[] =>
    filerRows(paneScope(paneOf(st.dual, side)), st.entryMetas, st.relations, {
      filterQuery: st.filterQuery,
      searchHits: st.searchHits,
      sort: st.entrySort,
    });

  const dualRowEl = (side: DualSide, lid: string): HTMLElement | null =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-pkc-region="dual-pane"] [data-pkc-action="dual-row"]',
      ),
    ).find(
      (el) => el.getAttribute('data-pkc-side') === side && el.getAttribute('data-pkc-entry') === lid,
    ) ?? null;

  /** ⚠ **その側の行に焦点があるときだけ**返す(反対側の行を動かさない)。 */
  const focusedDualLid = (side: DualSide): string | null => {
    const el = root.ownerDocument.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const tr = el.closest<HTMLElement>('[data-pkc-action="dual-row"]');
    if (tr === null || tr.getAttribute('data-pkc-side') !== side) return null;
    return tr.getAttribute('data-pkc-entry');
  };

  /** ⚠ 端では**止まる**(巻き戻さない ── 左の列と同じ規則)。 */
  const dualRowAt = (st: AppState, side: DualSide, delta: number): string | null => {
    const rows = dualRows(st, side);
    if (rows.length === 0) return null;
    const cur = focusedDualLid(side);
    const i = cur === null ? -1 : rows.findIndex((m) => m.lid === cur);
    if (i === -1) return (delta > 0 ? rows[0] : rows[rows.length - 1])?.lid ?? null;
    return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]?.lid ?? null;
  };

  /**
   * 🔴 **場所を移ったら、焦点を連れて行く**(#273。実ブラウザ smoke で判明)。
   *
   * ⚠ これが無いと **Enter で中へ入った次の 1 打鍵が死ぬ** ── 表は組み直され、
   *   焦点が乗っていた行は**その場で消える**ので、次の keydown の的は `body` になる。
   *   そこには `data-pkc-region="dual-pane"` の親が無いので、**この面の鍵は
   *   1 つも当たらなくなる**(user から見ると「入ったら急にキーが効かない」)。
   * ⚠ 左の列は同じ問題を `filer.ts` の側で解いている ── あちらは面が 1 つなので
   *   描画側で持てるが、こちらは**どちらのペインへ戻すか**が要るのでここで持つ。
   * 🔑 dispatch は同期に描画まで走るので、**この時点で新しい行が居る**。
   */
  const carryDualFocus = (side: DualSide): void => {
    const st = dispatcher.getState();
    const lid = paneOf(st.dual, side).selection[0] ?? dualRows(st, side)[0]?.lid ?? null;
    const row = lid === null ? null : dualRowEl(side, lid);
    if (row !== null) {
      row.focus();
      return;
    }
    /**
     * ⚠ **行が 1 つも無いときは器へ逃がす**(空のフォルダ)── ここを落とすと
     * 「入ったら鍵が全部死ぬ」に戻る。器は `tabIndex = -1` を持っている。
     */
    root
      .querySelector<HTMLElement>(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`)
      ?.focus();
  };

  /**
   * 🔴 **名前の打ち替えを確定する**(#273 段④)。
   *
   * ⚠ 改名の規則は既存の `RENAME_ENTRY_TITLE` **1 つ**(左の列・編集画面と同じ)。
   * 🔑 **空白だけ / 変わっていない、の判定はここに書かない** ── reducer が既に
   *   持っている(`title === '' || title === meta.title` で捨てる)。ここにも書くと
   *   **同じ問いに答える口が 2 つ**になり、片方だけ直したときに食い違う(CLAUDE.md §7)。
   */
  const commitDualRename = (lid: string, value: string): void => {
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: value });
    dispatcher.dispatch({ type: 'DUAL_RENAME_END' });
  };

  const runDualKey = (cmd: string, side: DualSide): boolean => {
    const st = dispatcher.getState();
    /**
     * ⚠ **無言で断らない**(左の列と同じ作法)── `preventDefault` は走るので、
     * 黙ると「押したのに何も起きず、ブラウザの既定まで消えた」になる。
     */
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してからフォルダの操作をしてください',
      });
      return true;
    }
    if (cmd === 'filer-row-down' || cmd === 'filer-row-up') {
      const lid = dualRowAt(st, side, cmd === 'filer-row-down' ? 1 : -1);
      if (lid === null) return false;
      // 🔑 送ると印も動く(OS のファイラ = 焦点と選択が一致する)
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'set' });
      dualRowEl(side, lid)?.focus();
      return true;
    }
    if (cmd === 'filer-extend-down' || cmd === 'filer-extend-up') {
      const from = focusedDualLid(side);
      const lid = dualRowAt(st, side, cmd === 'filer-extend-down' ? 1 : -1);
      if (lid === null) return false;
      // ⚠ 起点が無いときは、いまの行を起点に立ててから伸ばす
      //    (`rangeInRows` は起点 null を「行き先 1 件」と解くので、積み上がらない)
      if (paneOf(st.dual, side).anchor === null && from !== null)
        dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: from, mode: 'set' });
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'range' });
      dualRowEl(side, lid)?.focus();
      return true;
    }
    if (cmd === 'filer-select-all') {
      const rows = dualRows(st, side);
      const first = rows[0]?.lid;
      const last = rows[rows.length - 1]?.lid;
      if (first === undefined || last === undefined) return false;
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: first, mode: 'set' });
      if (last !== first)
        dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: last, mode: 'range' });
      return true;
    }
    if (cmd === 'filer-parent') {
      const scope = paneScope(paneOf(st.dual, side));
      if (scope === null) return false; // ルートで押しても何も起きない
      const up = getAncestorFolders(scope, st.entryMetas, st.relations)[0] ?? null;
      dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid: up?.lid ?? null });
      carryDualFocus(side);
      return true;
    }
    if (cmd === 'filer-open') {
      const lid = focusedDualLid(side) ?? paneOf(st.dual, side).selection[0] ?? null;
      if (lid === null) return false;
      // フォルダなら中へ(2 クリックと同じ ── 規則は `DUAL_SET_SCOPE` 1 か所)
      if (st.entryMetas.get(lid)?.archetype === 'folder') {
        dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid });
        carryDualFocus(side);
        return true;
      }
      return openNote(lid);
    }
    /**
     * 🔴 **消すのは、このペインの印だけ**(#273 段②)。
     *
     * ⚠ `false` を返して global の `delete-selected` に落とすと、**左の列の印**を消す ──
     * user は 2 ペインを見ているのに、**画面に出ていないものが消える**。
     * 🔑 実体は `deleteFrom` **1 本**(左の列と同じ確認・同じ断り方)── 相手の集合だけを
     *   このペインのものにして渡す。
     */
    if (cmd === 'filer-trash') {
      deleteFrom(dispatcher, services, dualRows(st, side), paneOf(st.dual, side).selection);
      return true;
    }
    return false;
  };

  const runFilerKey = (cmd: string): boolean => {
    const st = dispatcher.getState();
    /**
     * 🔴 **無言で断らない**(2026-08-18 の着地前レビュー 7)。
     *
     * `SET_SCOPE` も `SELECT_ALL` も reducer が `phase !== 'ready'` で**黙って
     * state を返す**ので、直す前は編集中に `Backspace` / `Ctrl+A` を押すと
     * **1 ドットも動かず理由も出なかった**(しかも `preventDefault` は走るので
     * ブラウザの既定 = 「前のページへ戻る」まで消えていた)。同じ面の
     * `Delete` は `delete-selected` が理由を出すので、**4 つの鍵で断り方が
     * 揃っていなかった**。⚠ 判定は**ここ 1 か所**(4 か所に散らさない)。
     */
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してからフォルダの操作をしてください',
      });
      return true;
    }
    if (cmd === 'filer-select-all') {
      dispatcher.dispatch({ type: 'SELECT_ALL' });
      return true;
    }
    if (cmd === 'filer-trash') {
      // ⚠ 実体は「まとめてゴミ箱へ」と同じ(確認・見えている印への絞り込み込み)
      run('delete-selected', root);
      /**
       * 🔴 **消したあとも焦点を連れて行く**(着地前レビュー 4)。表は
       * `entryMetas` が変わると `filer.ts` が丸ごと組み直すので、押した行と
       * 一緒に**焦点が body へ落ちる** ── 直す前は 1 回消したらそこで
       * `Backspace` も `Delete` も `Ctrl+A` も死んでいた(門に当たらなくなる)。
       * ⚠ 移動の 2 つ(`filer-parent` / `filer-open`)にだけ入れて、ここに
       *   入れていなかった ── CLAUDE.md「片側を直したら反対側を必ず疑う」。
       */
      return true;
    }
    if (cmd === 'filer-parent') {
      if (st.scopeLid === null) return false; // ルートで押しても何も起きない
      const up = getAncestorFolders(st.scopeLid, st.entryMetas, st.relations)[0] ?? null;
      dispatcher.dispatch({ type: 'SET_SCOPE', lid: up?.lid ?? null });
      return true;
    }
    if (cmd === 'filer-row-down' || cmd === 'filer-row-up') {
      const lid = rowAt(st, cmd === 'filer-row-down' ? 1 : -1);
      if (lid === null) return false;
      /**
       * 🔴 **送ると印も動く**(OS のファイラ = 焦点と選択が一致する)。
       * ⚠ **中央のノートは開き直さない** ── 開くのは `Enter` の仕事である
       *   (user 裁定 2026-08-18「Enter は閲覧を開始」)。`SELECT_ENTRY` を撃つと
       *   1 行送るたびに本文の読み直し(worker 往復)が起きる。
       * 🔑 既存の 2 つで足りる ── 印を空にしてから 1 件付ける(規則を増やさない)。
       *   これで起点(`selectionAnchor`)もその行に立つので、続く `Shift` が効く。
       */
      dispatcher.dispatch({ type: 'CLEAR_SELECTION' });
      dispatcher.dispatch({ type: 'TOGGLE_SELECT', lid });
      focusRow(lid);
      return true;
    }
    if (cmd === 'filer-extend-down' || cmd === 'filer-extend-up') {
      const from = focusedRowLid();
      const lid = rowAt(st, cmd === 'filer-extend-down' ? 1 : -1);
      if (lid === null) return false;
      /**
       * ⚠ **起点が無いときは、いまの行を起点に立ててから伸ばす**。
       * `rangeInRows` は起点 `null` を「行き先 1 件」と解くので、そのまま撃つと
       * **押すたびに 1 件へ潰れて**積み上がらない(OS は現在行から伸びる)。
       */
      if (st.selectionAnchor === null && from !== null) {
        dispatcher.dispatch({ type: 'CLEAR_SELECTION' });
        dispatcher.dispatch({ type: 'TOGGLE_SELECT', lid: from });
      }
      dispatcher.dispatch({ type: 'SELECT_RANGE', lid });
      focusRow(lid);
      return true;
    }
    if (cmd === 'filer-open') {
      // ⚠ 焦点が先、印は次 ── 理由は `focusedRowLid` の注記
      const lid = focusedRowLid() ?? st.selectedLid;
      if (lid === null) return false;
      // フォルダなら中へ(2 クリックと同じ)。⚠ 規則は 1 か所 ── `SET_SCOPE` を撃つ
      if (st.entryMetas.get(lid)?.archetype === 'folder') {
        dispatcher.dispatch({ type: 'SET_SCOPE', lid });
        return true;
      }
      return openNote(lid);
    }
    return false;
  };
  const doc = root.ownerDocument;
  /**
   * 🔴 **他所を押したら確定する**(#273 段④。OS のファイラと同じ)。
   *
   * ⚠ `renaming` の門は**変異試験で観測できない**(外しても test は全部通る)。
   *   `Esc` でやめた回は `DUAL_RENAME_END` が同期に走って入力欄が DOM から外れ、
   *   **外れた節点の focusout は root まで上がらない**ので、この handler に届かない
   *   ── だから Chromium では門が要らない。⚠ ただし「要素を外したときに focusout を
   *   出すか」は**エンジンで違う**ので、届いた回に打った値が蘇らないよう残している。
   *   「これが無いと壊れる」とは書かない(CLAUDE.md「外して壊れることを 1 度は見る」)。
   */
  const onRenameBlur = (ev: Event): void => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement) || !el.matches('[data-pkc-field="dual-rename"]')) return;
    if (dispatcher.getState().dual.renaming === null) return;
    const lid = el.getAttribute('data-pkc-entry');
    if (lid !== null) commitDualRename(lid, el.value);
  };
  root.addEventListener('focusout', onRenameBlur);
  doc.addEventListener('keydown', onShortcut);
  root.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('mousedown', onMousedown);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('focusout', onRenameBlur);
    doc.removeEventListener('keydown', onShortcut);
    root.removeEventListener('keydown', onKeydown);
  };
}
