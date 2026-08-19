/**
 * 右の付随情報ペイン(P8)。
 *
 * 🔑 **1 画面で完結**(user 指示 2026-08-03。業務画面の作法)── いま選んでいる
 * ものの**素性**と、それに**対する操作**を、本文の隣に常時置く。
 * 以前は素性を見る面が無く、操作は本文の上のツールバーに集約されていて、
 * **編集に入ると両方消えて** textarea 1 枚になっていた。
 *
 * ⚠ ここは**読むだけ**ではない ── 「操作は対象の隣」に従い、その entry に
 * 対する操作(書き出す・履歴・削除)はここが持つ。
 * ⚠ frontmatter を直に編集させる面(user 指示「基本は UI 導線ありき」)は
 * 次の段。この段では**素性を見せて、操作を隣に戻す**ところまで。
 *
 * ─────────────────────────────────────────────
 * 🔴 **器を捨てない。値だけ差し替える**(2026-08-06)。
 *
 * 直す前はこの面が「断面指紋が変わったら `region.textContent = ''` して全部
 * 作り直す」形だった。それで **user が押そうとしているボタンを捨てていた**:
 *
 * - 保存すると storage worker の ack が**遅れて**届き、`ENTRY_STAMPED` が
 *   `entryMetas` の meta を**必ず新しい参照**で差し替える(`app-state.ts` の
 *   `new Map(...).set(lid, {...meta, updatedAt})`)── 参照比較の指紋が外れる
 * - その瞬間にこの面が丸ごと作り直され、`show-history` / `delete-entry` の
 *   `<button>` は**別の node** になる
 * - binder は委譲 + `closest` で拾い、**`root.contains(el)` を通らない target を
 *   黙って捨てる** ── 保存直後に「履歴」を押すと**無言の dead click** になる
 * - しかも出している時刻は**日付だけ**なので、同日中の保存では作り直した結果が
 *   **byte 同一**。つまり「同じ絵を描き直すために、押される寸前のボタンを捨てて」いた
 *
 * ⚠ これは PKC2 の失敗と同型である ── 「編集のたびに一覧を全行作り直す」。
 *   PKC3 は**一覧は直した**(`sidebar.ts` が lid キーで node を使い回す)のに、
 *   P8 で後から生えたこの面が同じ罠を再発明していた。しかもこちらは**ボタンを
 *   持つ面**なので、体感だけでなく**操作が落ちる**ぶん悪い。
 *
 * 🔑 **指紋を廃した**のも意図である ── 「指紋の次元を足し忘れて古い値を出す」
 * バグ族を 2 回踏んでいる(`lastLink` 2026-08-05 / `lastRelations` 2026-08-06)。
 * **毎回値を計算して、違うものだけ書く**なら、その族は原理的に発生しない。
 * ⚠ 器を組み直すのは**形が変わるときだけ**(選択の有無 / 「書き戻す」の有無)。
 */
import type { AppState } from '@adapter/state/app-state';
import { ScrollMemory } from './scroll-memory';
import { archetypeLabel } from './sidebar';
import { iconButton } from './icons';
// ⚠ 日付の切り方は `features/datetime/stored-date` が正本(一覧の行と共有)。
//    ここで独自に parse していた頃は、一覧に日付を出すときに規則が 2 つに増えた
import { formatStoredDate } from '@features/datetime/stored-date';
// 居場所の解決は `features/relation/tree` が正本(ファイラの帯・パンくずと共有)
import { readTags } from '@features/flavor/tags';
import {
  CREATABLE_KINDS,
  RELATION_LABELS,
  STRUCTURAL,
  relationLabel,
} from '@features/relation/kinds';

/** 相手の候補に出す上限。⚠ 超えたぶんは**件数を書く**(黙って切らない)。 */
export const RELATION_CANDIDATE_MAX = 200;
import { getAncestorFolders } from '@features/relation/tree';

/** 素性の行(`data-pkc-field` → 値を入れる `<dd>`)。 */
type Rows = Map<string, HTMLElement>;
/** 操作の行(`data-pkc-action` → その `<button>`)。 */
type Buttons = Map<string, HTMLButtonElement>;

/**
 * 器の**形**。これが変わるときだけ組み直す。
 * ⚠ 形に入れるのは「**要素が在るか無いか**」だけ ── 値は形ではない。
 */
type Shape = 'empty' | 'entry' | 'entry+link';

/** 値が変わっていなければ DOM に触れない(触ると text node が差し替わる)。 */
function setText(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

/** 属性も同じ ── 同じ値の再代入で mutation observer を起こさない。 */
function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export class InspectorRenderer {
  /** 組み終わった器の先頭(`region` に繋がっているかで生存を判定する)。 */
  private head: HTMLElement | null = null;
  private shape: Shape | null = null;
  private rows: Rows = new Map();
  private buttons: Buttons = new Map();
  /** 相手の候補(#185)。⚠ 器は 1 度だけ組み、中身だけ差し替える。 */
  private candidates: HTMLDataListElement | null = null;
  /** 同じノートに戻ったら同じ位置へ(P8 段⑫。溢れるのは題名が長いときだけ)。 */
  private readonly scroll: ScrollMemory;
  /** いま出しているノート。⚠ **切り替わったときだけ**スクロールを触る。 */
  private shownLid: string | null = null;

  constructor(private readonly region: HTMLElement) {
    this.scroll = new ScrollMemory(region);
  }

  render(state: AppState): void {
    const meta = state.selectedLid ? state.entryMetas.get(state.selectedLid) : undefined;
    // 🔴 紐づけは**取込の後**に届く(`FILE_LINKED`)── 出す/出さないが形を決める
    const link = (state.selectedLid && state.linkedFiles.get(state.selectedLid)) || null;
    const shape: Shape = !meta ? 'empty' : link !== null ? 'entry+link' : 'entry';
    const lid = meta?.lid ?? null;

    /**
     * ⚠ 生存判定に `isConnected` を使わない ── 器が document に繋がる前に描く経路
     * (骨組みを組んでから親へ入れる / test)を黙って落とす。見るのは
     * 「**自分が組んだ器が、いまも自分の region の子か**」だけ。
     */
    const alive = this.head !== null && this.head.parentElement === this.region;
    if (!alive || this.shape !== shape) {
      // 形が変わった(または器を失った)ときだけ組み直す
      this.scroll.park();
      this.build(shape);
      this.shape = shape;
    }

    if (!meta) {
      this.shownLid = null;
      return;
    }

    // ── ここから下は**値の差し替えだけ**(器は触らない)
    const noteChanged = this.shownLid !== lid;
    if (noteChanged) this.scroll.park();

    this.setRow('inspector-title', meta.title);
    this.setRow('inspector-kind', archetypeLabel(meta.archetype));
    /**
     * 🔴 **どこに居るかを出す**(2026-08-06。user 報告 minor「一覧タブから
     * 所属フォルダを知る手段が無い」)。
     *
     * 一覧は平置きなので、そのノートがどのフォルダに入っているかは
     * **フォルダタブへ移らないと分からなかった**(移ると探し直しになる)。
     * ⚠ 解決は `features/relation/tree` の 1 本(パンくず・移動の帯と同規則)。
     * ⚠ root 直下は空文字ではなく **「ルート」**と書く ── 空欄は「不明」に見える。
     */
    const chain = getAncestorFolders(meta.lid, state.entryMetas, state.relations)
      .reverse()
      .map((f) => f.title);
    this.setRow('inspector-folder', chain.length === 0 ? 'ルート' : chain.join(' / '));
    /**
     * 🔴 **タグを押せる札にする**(#182)。押すと**そのタグで探す** ── #181 で
     * 本文が検索対象になったので、frontmatter の `tags:` もそのまま引ける。
     * ⚠ **新しい絞り込み機構を足さない**(founding「盛り込みすぎない」)。
     * ⚠ 本文が読めていないとき(一覧を眺めているだけ)は**行ごと空** ── 嘘の
     *   「タグ無し」を出さない。
     */
    const tagBox = this.rows.get('inspector-tags');
    if (tagBox) {
      const body = state.openBody?.lid === meta.lid ? state.openBody.body : null;
      const tags = body === null ? null : readTags(body);
      tagBox.textContent = '';
      if (tags === null) {
        tagBox.textContent = '—';
      } else if (tags.length === 0) {
        tagBox.textContent = '無し';
      } else {
        for (const tag of tags) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.setAttribute('data-pkc-action', 'filter-by-tag');
          chip.setAttribute('data-pkc-tag', tag);
          chip.setAttribute('data-pkc-field', 'inspector-tag');
          chip.title = `「${tag}」を含むノートを探します`;
          chip.textContent = tag;
          tagBox.append(chip);
        }
      }
    }
    /**
     * 🔴 **関係を出す**(#185)。⚠ 出すのは**親子以外** ── 居場所は上の行が既に
     * 出しており、同じものを 2 か所に出すと「消したのに片方に残る」に見える。
     * ⚠ 相手は**押せる**(その関係を辿れないと、一覧しても行き止まりになる)。
     * ⚠ 消すボタンを対で置く ── **作れて消せない導線は dead click の一種**。
     */
    const relBox = this.rows.get('inspector-relations');
    if (relBox) {
      relBox.textContent = '';
      const mine = state.relations.filter(
        (r) => r.kind !== STRUCTURAL && (r.fromLid === meta.lid || r.toLid === meta.lid),
      );
      if (mine.length === 0) {
        relBox.textContent = '無し';
      } else {
        for (const r of mine) {
          const otherLid = r.fromLid === meta.lid ? r.toLid : r.fromLid;
          const other = state.entryMetas.get(otherLid);
          const item = document.createElement('span');
          item.setAttribute('data-pkc-field', 'inspector-relation');
          item.setAttribute('data-pkc-relation', r.id);
          const label = document.createElement('span');
          // ⚠ 向きを出す(→ / ←)── 出典と関連は向きで意味が変わる
          label.textContent = `${relationLabel(r.kind)} ${r.fromLid === meta.lid ? '→' : '←'} `;
          const go = document.createElement('button');
          go.type = 'button';
          go.setAttribute('data-pkc-action', 'select-entry');
          // ⚠ 属性名は既存の規約に合わせる(`select-entry` は `data-pkc-entry` を読む)
          //    ── ここで別名を作ると、押しても動かない導線になる(実際 1 度作った)
          go.setAttribute('data-pkc-entry', otherLid);
          go.setAttribute('data-pkc-field', 'relation-target-link');
          // ⚠ 相手が消えていても**黙って空にしない**(何が壊れているか分かる形)
          go.textContent = other?.title ?? '(見つかりません)';
          const del = iconButton('remove-relation', '消す');
          del.setAttribute('data-pkc-relation', r.id);
          del.title = 'この関係を消します(ノートは消えません)';
          item.append(label, go, del);
          relBox.append(item);
        }
      }
    }
    /**
     * 相手の候補。⚠ **出し切れないときは件数を書く**(黙って切らない)。
     * ⚠ 自分自身は候補から外す(張れないものを見せない)。
     */
    if (this.candidates) {
      const others = [...state.entryMetas.values()].filter((m) => m.lid !== meta.lid);
      this.candidates.textContent = '';
      for (const m of others.slice(0, RELATION_CANDIDATE_MAX)) {
        const opt = document.createElement('option');
        opt.value = m.title;
        this.candidates.append(opt);
      }
      if (others.length > RELATION_CANDIDATE_MAX) {
        const more = document.createElement('option');
        more.value = `(候補は ${RELATION_CANDIDATE_MAX} 件まで表示。ほかに ${others.length - RELATION_CANDIDATE_MAX} 件あります)`;
        this.candidates.append(more);
      }
    }
    this.setRow('inspector-created', formatStoredDate(meta.createdAt));
    this.setRow('inspector-updated', formatStoredDate(meta.updatedAt));
    // 🔴 **どのファイルから来たか**を出す(2026-08-05)── 出さないと、書き戻しが
    //    「どこへ」書くのか分からない操作になる。⚠ 行の有無は形(= build 側)
    if (link !== null) this.setRow('inspector-linked-file', link);

    /**
     * 🔴 **編集中は押せなくする**(P8 段⑲)。
     *
     * 直す前は 3 つとも押せる見た目のまま出ていたが、実際には
     * `DELETE_ENTRY` / `SHOW_HISTORY` が `phase !== 'ready'` で**黙って何もしない**
     * ── 押しても画面が 1 ドットも変わらず、user には「壊れている」としか見えない。
     * ⚠ **消さずに、押せなくする**(業務画面の作法「同じものが常に同じ場所にある」)。
     * ⚠ 理由を `title` に書く ── 押せない理由が分からないほうが困る。
     */
    const editing = state.phase !== 'ready';
    for (const [action, b] of this.buttons) {
      const why = ACTION_TITLES[action] ?? '';
      const title = action === 'write-back-file' ? whyWriteBack(link) : why;
      /**
       * 🔴 **居場所(`data-pkc-entry`)を必ず書き直す** ── ここを落とすと、
       * 選択を切り替えたあとのボタンが**前のノートを指したまま**になる。
       * 「削除」がそれをやると**別のノートを消す**(ファイラの帯で実際に踏んだ形)。
       */
      setAttr(b, 'data-pkc-entry', meta.lid);
      if (b.disabled !== editing) b.disabled = editing;
      const shown = editing ? `${title}(編集中は使えません ── 確定するか取り消してください)` : title;
      if (b.title !== shown) b.title = shown;
    }

    // ⚠ **中身を入れ終わってから**戻す(空の器に書いても丸められる)。
    //    ⚠ 同じノートを描き直しただけのときは**触らない** ── 触ると、
    //      保存の ack が届いた瞬間にスクロールが戻る
    if (noteChanged) {
      this.shownLid = lid;
      this.scroll.use(meta.lid);
    }
  }

  /** 値を入れる。⚠ 器に無い field を書こうとしたら形の宣言が漏れている。 */
  private setRow(field: string, value: string): void {
    const dd = this.rows.get(field);
    if (dd) setText(dd, value);
  }

  /** 器を組む(形が変わったときだけ呼ばれる)。 */
  private build(shape: Shape): void {
    this.region.textContent = '';
    this.rows = new Map();
    this.buttons = new Map();

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = '情報';
    this.region.append(head);
    this.head = head;

    if (shape === 'empty') {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'inspector-empty');
      empty.textContent = '左の一覧から選ぶと、ここに情報が出ます。';
      this.region.append(empty);
      this.scroll.use('');
      return;
    }

    const dl = document.createElement('dl');
    const row = (label: string, field: string): void => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-field', field);
      dl.append(dt, dd);
      this.rows.set(field, dd);
    };
    row('題名', 'inspector-title');
    row('種類', 'inspector-kind');
    row('居場所', 'inspector-folder');
    row('作成', 'inspector-created');
    row('更新', 'inspector-updated');
    /**
     * 🔴 **タグ**(#182 / 台帳 #180 の A-2)。⚠ 値は文字ではなく**押せる札**なので、
     * `setRow`(textContent 差し替え)ではなく専用の器を持つ。
     */
    row('タグ', 'inspector-tags');
    /**
     * 🔴 **関係**(#185 / 台帳 #180 の A-7)。⚠ 親子(居場所)は上の「居場所」行が
     * 既に出しているので、ここは**それ以外**(関連 / 分類 / 時系列 / 出典)を出す。
     * ⚠ 値は押せる札 + 消すボタンなので、`setRow` ではなく専用の器を持つ。
     */
    row('関係', 'inspector-relations');
    if (shape === 'entry+link') row('元ファイル', 'inspector-linked-file');
    this.region.append(dl);

    /**
     * 🔴 **関係を作る帯**(#185)。⚠ 器は 1 度しか組まない ── 値だけ差し替える
     * (打ちかけの相手名が再描画で消えない。追記欄と同じ理由)。
     * ⚠ 相手は**題名で指す** ── lid は user に見えない値なので選ばせられない。
     *   候補は `<datalist>` に出し、**出し切れないときは件数を書く**(黙って切らない)。
     */
    const addBar = document.createElement('div');
    addBar.setAttribute('data-pkc-field', 'relation-add');
    const target = document.createElement('input');
    target.type = 'text';
    target.setAttribute('data-pkc-field', 'relation-target');
    target.setAttribute('list', 'pkc-relation-candidates');
    target.placeholder = '相手の題名';
    target.setAttribute('aria-label', '関係を結ぶ相手の題名');
    const list = document.createElement('datalist');
    list.id = 'pkc-relation-candidates';
    this.candidates = list;
    const kind = document.createElement('select');
    kind.setAttribute('data-pkc-field', 'relation-kind');
    kind.setAttribute('aria-label', '関係の種類');
    for (const k of CREATABLE_KINDS) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = RELATION_LABELS[k];
      kind.append(opt);
    }
    const add = iconButton('add-relation', '関係を足す');
    add.title = '選んでいるノートから、相手のノートへ関係を張ります';
    addBar.append(target, list, kind, add);
    this.region.append(addBar);

    // ⚠ **操作は対象の隣**(P8)。共通ツールバーに集約しない
    const actions = document.createElement('div');
    actions.setAttribute('data-pkc-field', 'inspector-actions');
    const btn = (action: string, label: string): void => {
      const b = iconButton(action, label);
      actions.append(b);
      this.buttons.set(action, b);
    };
    // ⚠ 文言は**実際に落ちるもの**に合わせる(P8 段⑱)── ここは可逆な
    //    アーカイブで、Markdown ではない(マニュアル §5 の表と同じ材料)
    btn('export-entry', '書き出す');
    // 🔴 **Word で出す**(#187 段①)。⚠ 隣の「書き出す」と**別の物**である ──
    //    あちらは取り込み直せるバックアップ、こちらは片道の Word 文書
    btn('export-entry-docx', 'Word');
    if (shape === 'entry+link') btn('write-back-file', '書き戻す');
    btn('show-history', '履歴');
    btn('delete-entry', '削除');
    this.region.append(actions);
  }
}

/**
 * 押せる操作の説明。⚠ **1 か所に持つ** ── 器を組む所と値を入れる所に別々に
 * 書くと、片方だけ古くなる(この repo が何度も踏んでいる形)。
 */
const ACTION_TITLES: Record<string, string> = {
  'export-entry': 'このノートだけをバックアップ形式(.pkc3.zip)で保存します。取り込み直せます',
  // 🔴 **実装に合わせる**(2026-08-18)。直す前は「この版では画像は入りません」と
  //    書いてあったが、画像も図もグラフも**入る**(`features/export/docx.ts` の VML /
  //    `svg-emf.ts` のベクタ)。マニュアル(§5)もお知らせ 2 件も「入る」と言っており、
  //    ⚠ **画面の説明だけが古いまま user に嘘をついていた**(押すのを諦めさせる向き)。
  'export-entry-docx':
    'このノートを Word 文書(.docx)で保存します。片道です(画像も、図はベクタで、グラフは絵で入ります)',
  'show-history': '過去の版を一覧します',
  'delete-entry': 'ゴミ箱へ移します(フォルダ画面から戻せます)',
};

/** 「書き戻す」だけは行き先(ファイル名)を文言に含める。 */
function whyWriteBack(link: string | null): string {
  return `開いた元のファイル(${link ?? ''})を、このノートの内容で上書きします`;
}
