/**
 * ランチャーのタイル(P7b 段⑩)。
 *
 * > user 指示 2026-08-03「**ランチャーも使いやすければ、なんでもいいよ**」
 * > user 指示 2026-08-03「**PKC2 に寄せる必要は無い**」
 *
 * 🔴 これは「新機能」ではなく、**取り込んだデータの到達不能の解消**である。
 * `attachment-flavor.ts` は PKC2 の `registered_as_app` / `launcher_url` /
 * `app_group` / `app_order` を取込時に**欠損なく写している**のに、それを出す面が
 * 無かった ── 移行した user は自分のタイルが入っているのに 1 つも見えない。
 *
 * ⚠ **PKC2 の形は踏襲しない**。PKC2 はグループの折り畳み・drag & drop 並べ替え・
 * 拡張ホストまで持っていたが、ここが引き継ぐのは**並び順の意味論**だけ
 * (移行後にタイルの順番が変わらない)。見せ方は PKC3 の流儀
 * (絞り込みと同じ「探して起動する」)に寄せる。
 *
 * 🔑 **pure module**。browser API を使わない ── 起動(window.open / blob)は
 * adapter 側の責務で、ここは「何を・どの順で並べるか」だけを決める。
 */
import { parseFrontmatter } from '../markdown/frontmatter';

export interface LauncherTile {
  lid: string;
  title: string;
  /** 並べるための内部値(`app_order`)。⚠ 表示には使わない。 */
  order?: number | undefined;
  /** グループ名。未設定は空文字(= 既定グループ)。 */
  group: string;
  /**
   * 目印の 1 字(emoji)。
   * 🔴 取込は `app_icon` を**欠損なく写していた**のに、出す側が無かった
   * (P8 段⑭ で判明)── PKC2 で付けた目印が全部消えて見えていた。
   * ⚠ 画像アイコン(`app_icon_asset_key`)はまだ出さない ── IDB Blob の
   * 貸し借りが要るので、1 字の目印だけで識別価値が足りるうちは足さない。
   */
  icon?: string;
  /**
   * 起動の仕方。⚠ `url` は外部サイト、`app` は同梱 HTML、
   * `office` / `dual` / `schedule` / `manual` は**組み込み**(entry を持たない ──
   * #148 / #241 / #673 / #645)。
   * 🔑 **`ViewMode` と同じ綴りの種別は、PKC をもう 1 枚別窓で開く**
   *   (`launch-tile.ts` が `isViewMode(kind)` で見分ける ── 名指しの `if` を並べない)。
   */
  kind: 'app' | 'url' | 'office' | 'dual' | 'schedule' | 'manual';
  /** `kind === 'url'` のときの飛び先。 */
  url?: string;
  /** `kind === 'app'` のときの実体(IDB Blob の鍵)。 */
  assetKey?: string;
  mime?: string;
}

/** タイルの元になりうる entry(body は frontmatter だけ読めればよい)。 */
export interface TileSource {
  lid: string;
  title: string;
  body: string;
}

/** http/https だけ。⚠ `javascript:` 等を弾く(PKC2 と同じ向きの判断)。 */
export function isLaunchableUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

/**
 * アプリとして開けるのは **HTML だけ**。
 *
 * 🔑 起動は「隔離した外殻の `srcdoc` に中身を入れる」形になった
 * (`app-shell.ts` ── 添付を同じ origin で走らせない)。この器に PDF や画像の
 * bytes を入れても**文字化けが出るだけ**なので、押しても何も起きないタイルを
 * 出さないという上の判断(`isLaunchableUrl`)と**同じ向き**で落とす。
 * ⚠ mime 未設定は HTML 扱い(PKC2 の古い書出しは mime を持たないことがある)。
 * ⚠ ここで落ちても添付そのものは消えない ── 一覧から普通に開ける。
 */
export function isAppMime(mime: string | undefined): boolean {
  return mime === undefined || /^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(mime);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * 1 件を読む。タイルにならないものは `null`。
 *
 * ⚠ **`registered_as_app` が真** か **`launcher_url` を持つ** もののみ。
 * 片方だけで判定すると、PKC2 の URL タイル(`registered_as_app` も真)と
 * 素の添付が混ざる。
 */
export function tileFrom(src: TileSource): LauncherTile | null {
  const fm = parseFrontmatter(src.body).meta;
  const url = str(fm['attachment.launcher_url']);
  const registered = fm['attachment.registered_as_app'] === true;
  if (!registered && url === undefined) return null;

  const group = str(fm['attachment.app_group']) ?? '';
  const orderRaw = fm['attachment.app_order'];
  const order = typeof orderRaw === 'number' && Number.isFinite(orderRaw) ? orderRaw : undefined;
  // ⚠ 2 字までに切る ── 長い文字列を入れられると行の高さが崩れる。
  //    `[...]` で切る(サロゲートペアを割らない ── 絵文字が壊れる)
  const iconRaw = str(fm['attachment.app_icon']);
  const icon = iconRaw === undefined ? undefined : [...iconRaw].slice(0, 2).join('');
  const base = { lid: src.lid, title: src.title, group, order, icon };

  if (url !== undefined) {
    // ⚠ 開けない URL は**タイルにしない**(押しても何も起きないタイルを出さない)
    if (!isLaunchableUrl(url)) return null;
    return { ...base, kind: 'url', url };
  }
  const assetKey = str(fm['attachment.asset_key']);
  // ⚠ bytes を指していない「アプリ」は起動しようがない
  if (assetKey === undefined) return null;
  const mime = str(fm['attachment.mime']);
  // ⚠ HTML 以外は器(`srcdoc`)に入れても文字化けにしかならない ──
  // 「押しても何も起きないタイルを出さない」と同じ向きで落とす
  if (!isAppMime(mime)) return null;
  return { ...base, kind: 'app', assetKey, mime };
}

/**
 * 並べる。**グループ名 → `app_order` → 元の順** の安定ソート。
 *
 * ⚠ 既定グループ(空文字)は**先頭**に来る(空文字は文字列比較で最小)──
 * PKC2 も未設定を既定群として先に出していたので、移行後に
 * 「いつものタイルが下に消えた」を起こさない。
 * ⚠ `app_order` 未設定は**末尾**(登録順を保つ)。
 */
export function sortTiles(tiles: readonly LauncherTile[]): LauncherTile[] {
  const withOrder = tiles.map((t, i) => ({ t, i, order: t.order }));
  withOrder.sort((a, b) => {
    if (a.t.group !== b.t.group) {
      // ⚠ グループ名の無いもの(空文字)は**文字列比較で必ず先頭に来る**ので、
      // 特別扱いは要らない。当初 `if (group === '') return -1` を書いていたが、
      // 外しても振る舞いが変わらず変異試験で生き残った ── 消した
      // (test が守れないものは持たない、というこのリポジトリの規律)
      return a.t.group < b.t.group ? -1 : 1;
    }
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.i - b.i; // 安定(元の順)
  });
  return withOrder.map((x) => x.t);
}

/** 元データからタイル一覧を作る(読めないものは黙って落とす)。 */
export function buildTiles(sources: readonly TileSource[]): LauncherTile[] {
  const tiles: LauncherTile[] = [];
  for (const src of sources) {
    const tile = tileFrom(src);
    if (tile) tiles.push(tile);
  }
  return sortTiles(tiles);
}

/**
 * 🔴 組み込みタイルの lid(#148、user 裁定 2026-08-14「組み込みタイルの案を採用」)。
 * entry を持たないので、entry の lid と衝突しない固定値にする。
 * ⚠ `pkc-` で始めない ── goldens の正規化が id らしき名前を機械的に潰す
 * リポジトリでは、「id らしく見える名前」は id として扱われる(CLAUDE.md §9)。
 */
export const OFFICE_TILE_LID = 'builtin:office';

/** Office(Start Center)を開く組み込みタイル。 */
export function officeTile(): LauncherTile {
  return { lid: OFFICE_TILE_LID, title: 'Office', group: '', kind: 'office' };
}

/**
 * 🔴 **2 ペインタブファイラの組み込みタイル**(#241。user 指摘 2026-08-19
 * 「2 ペインファイラはアプリとして Office のように組み込みの導線を用意しろ」)。
 *
 * ⚠ 1 稿目は左の列の下(設定・フラグ・ヘルプが並ぶ「アプリ全体の操作」)に
 * ボタンを置いていた ── **user が言った「組み込み」はそこではない**。
 * Office と同じく**アプリの一覧に出る**のが正しい形である。
 * 🔑 Office との違いは**出る条件**: Office 一式は端末に入れた人だけだが、
 * この面は**アプリに最初から在る**ので、常に出す。
 */
export const DUAL_TILE_LID = 'builtin:dual';

export function dualTile(): LauncherTile {
  return { lid: DUAL_TILE_LID, title: '2 ペインで整理', group: '', kind: 'dual' };
}

/**
 * 🔴 **予定表の組み込みタイル**(#673 段②。user 裁定 2026-09-04
 * 「**予定表も連絡先も別窓、アプリの基本は別窓**」)。
 *
 * ⚠ #292 段⑤ で「カレンダー / やることの板はアプリではない」としてタイルから
 *   外したが、user の裁定で**別窓の口を戻す**。⚠ **左の列の「予定」タブは残る** ──
 *   これは引っ越しの取り消しではなく、同じ面に**2 つ目の入口**を付けるものである
 *   (本文を退かさずに開く道と、別窓で広く使う道の両方を持つ)。
 * 🔑 `kind` は `ViewMode` の綴り(`schedule`)と同じにする ── `launch-tile.ts` が
 *   それを見て別窓へ渡す。
 */
export const SCHEDULE_TILE_LID = 'builtin:schedule';

export function scheduleTile(): LauncherTile {
  return { lid: SCHEDULE_TILE_LID, title: '予定表', group: '', kind: 'schedule' };
}

/**
 * 🔴 **マニュアルの組み込みタイル**(#645。user 要望 2026-08-31
 * 「**ヘルプの中からマニュアルをアプリとして出してください**」)。
 *
 * ⚠ **これは「ノートの見方」ではない**ので、#292 でカレンダーを外した判定
 * (下の `withBuiltinTiles` の「閉じたとき user が失うものは何か」)に照らして
 * **アプリで正しい** ── マニュアルの窓を閉じて失うのはマニュアルだけである。
 *
 * 🔑 開く先は **PKC をもう 1 枚ではない**(`kind: 'dual'` との違い)──
 * `platform/manual-window.ts` が独立した document を組む。
 */
export const MANUAL_TILE_LID = 'builtin:manual';

export function manualTile(): LauncherTile {
  return { lid: MANUAL_TILE_LID, title: 'マニュアル', group: '', kind: 'manual' };
}

/**
 * 🔴 **カレンダーの組み込みタイル**(#276。封印の解除。user 指示 2026-08-19
 * 「かつて無くしたカレンダーとカンバンはここで生きてきます / 発想を変え、
 * frontmatter でのカレンダー情報付与や…で復活させるのです」)。
 *
 * ⚠ **`ViewMode` の切替を上の帯へ戻さない** ── #241 の訂正で確立した形
 * (組み込みはアプリの一覧から開く)。描画器も面も生きているので、
 * 封印を解くのは**導線の付け直し**である(`features/sealed.ts` の言うとおり)。
 */
/**
 * 組み込み分を entry 由来の一覧へ合流させる。
 *
 * 🔑 Office 一式は**端末ローカル**(IndexedDB)だが、entry はコンテナに乗って
 * 端末間を移動する ── だから組み込みは entry にせず、「一式が入っている端末に
 * だけ出す」をここ(合流)で決める(裁定の決め手)。
 * ⚠ entry 由来の並び(`sortTiles` 済み)には触らない。組み込みは既定グループの
 * **先頭**に置く ── 同じものが常に同じ場所にある(不可侵指示)。
 */
export function withBuiltinTiles(
  tiles: readonly LauncherTile[],
  opts: { office: boolean },
): LauncherTile[] {
  /**
   * ⚠ **並びは固定**(同じものが常に同じ場所にある ── 不可侵指示)。
   * 2 ペインは**アプリに最初から在る**ので先頭、Office は**入れた端末だけ**なので
   * その次 ── 入れたり消したりで 2 ペインの位置が動かない向きに並べる。
   */
  /**
   * ⚠ **カレンダー / やることの板は外した**(#292 段⑤、2026-08-23)──
   *   あの 2 つは「アプリ」ではなく**ノートの見方**だった。
   * 🔑 見分け方:**それを閉じたとき user が失うものは何か。** Office を閉じれば
   *   Office が消えるだけだが、**カレンダーを閉じて自分のノートが見えなくなるのは
   *   おかしい**。引っ越し先は左の列の「予定」タブ。
   */
  /**
   * ⚠ **マニュアルは最後に置く**(#645)── 2 ペインと Office は「作業する所」で、
   *   マニュアルは「読む所」である。作業の口の位置を、読み物で動かさない。
   */
  /**
   * 🔴 **予定表は 2 ペインの次**(#673 段②。user 裁定 2026-09-04)。
   * ⚠ 上の「外した」は**左の列へ移した経緯**として残す ── 戻したのは
   *   **別窓の入口**であって、左のタブを消したのではない(`scheduleTile` の注記)。
   * ⚠ アプリに最初から在るものを**先に**、端末次第の Office を**その後に**並べる
   *   ── Office の有無で予定表の位置が動かない向き。
   */
  const builtin: LauncherTile[] = [dualTile(), scheduleTile()];
  if (opts.office) builtin.push(officeTile());
  builtin.push(manualTile());
  return [...builtin, ...tiles];
}

/**
 * 押したとき entry の選択を立てるか。
 * ⚠ 組み込みタイルは entry を持たない ── 選択を立てると右の列が
 * 「見つからない」になる(存在しない lid を `selectedLid` に入れない)。
 */
export function tileSelectsEntry(tile: LauncherTile): boolean {
  return !BUILTIN_KINDS.has(tile.kind);
}

/**
 * 🔴 **entry を持たない組み込みの種別**。⚠ 表を 1 つにする ── 足すたびに
 * `!==` を並べると、足し忘れた所だけ「存在しない lid を選択に入れる」
 * (右の列が「見つからない」になる)。
 */
export const BUILTIN_KINDS: ReadonlySet<LauncherTile['kind']> = new Set([
  'office',
  'dual',
  'schedule',
  'manual',
]);
