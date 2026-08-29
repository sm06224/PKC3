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
import { phaseDisabledNote, type AppState } from '@adapter/state/app-state';
import type { EntryMeta } from '@core/model/entry-meta';
import { ScrollMemory } from './scroll-memory';
import { archetypeLabel } from './sidebar';
import { formatEntryLink } from '@features/entry-ref/entry-ref-format';
import { iconButton } from './icons';
// ⚠ 日付の切り方は `features/datetime/stored-date` が正本(一覧の行と共有)。
//    ここで独自に parse していた頃は、一覧に日付を出すときに規則が 2 つに増えた
import { formatStoredDate } from '@features/datetime/stored-date';
// 居場所の解決は `features/relation/tree` が正本(ファイラの帯・パンくずと共有)
import { readTags, sameTag } from '@features/flavor/tags';
import { collectEntryTags } from '@features/flavor/entry-tags';
import { extractHeadingsFromMarkdown } from '@features/markdown/markdown-toc';
import { frontmatterProblem } from '@features/markdown/frontmatter';
import { externalImageUrls } from '@features/asset/inline-url-adopt';
import {
  CREATABLE_KINDS,
  RELATION_LABELS,
  STRUCTURAL,
  relationLabel,
} from '@features/relation/kinds';

/** 相手の候補に出す上限。⚠ 超えたぶんは**件数を書く**(黙って切らない)。 */
export const RELATION_CANDIDATE_MAX = 200;
import { getAncestorFolders } from '@features/relation/tree';
import { BODY_LINK_KIND, renderRelationMap } from './relation-map';
import { bodyLinkTargets } from '@features/entry-ref/body-links';
import { ENTRY_ACTION_LABELS } from '@features/entry-actions';

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
  /** タグの候補(#494 段②)。⚠ 器は 1 度だけ組み、中身だけ差し替える。 */
  private tagCandidates: HTMLDataListElement | null = null;

  /** 関係を足す帯の部品(#513: 編集中に押せなくするために持つ)。 */
  private relAdd: {
    target: HTMLInputElement;
    kind: HTMLSelectElement;
    add: HTMLButtonElement;
  } | null = null;
  /** タグを打つ欄の器(#494)。⚠ 打てない状況では**畳む**(押せない物を出さない)。 */
  private tagForm: HTMLElement | null = null;
  /** 同じノートに戻ったら同じ位置へ(P8 段⑫。溢れるのは題名が長いときだけ)。 */
  private readonly scroll: ScrollMemory;
  /** いま出しているノート。⚠ **切り替わったときだけ**スクロールを触る。 */
  private shownLid: string | null = null;
  /**
   * 🔴 **外部画像の枚数を憶えておく**(#264 段①)。
   *
   * ⚠ この面は**状態が動くたびに render する**(指紋を持たないのが意図 ──
   *   file 冒頭)。`scanLinks` は本文を 1 文字ずつ読む状態機械なので、
   *   **実測: 10KB=0.57ms / 100KB=1.37ms / 1MB=15.9ms**(node 実測 20 回平均)
   *   ── 大きいノートを開いている間、保存の ack が届くたびに 16ms 払うことになる。
   * 🔑 憶えるのは**本文そのもの**である ── `openBody` の器は
   *   `{...ob, persisted}` で作り直されるが、`body` の文字列は同じ物が渡る。
   *   ⚠ lid で憶えると、同じノートを書き換えたときに古い枚数が残る。
   */
  private imgCount: { body: string; count: number } | null = null;

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

    /**
     * 🔴 **編集中に「押せるのに無言で捨てる」口を作らない**(#513)。
     * 操作の帯(`this.buttons`)は下の loop が押せなくするが、日付・関係の×・
     * 関係を足す帯は帯の loop の**対象外**で、reducer が `phase !== 'ready'` を
     * 黙って捨てる ── 欄まで空になり**成功と同じ見た目**になっていた。
     * 判定はここ 1 か所で採り、塗る先それぞれへ配る(§7: 同じ問いに 2 つ答えない)。
     */
    const editing = state.phase !== 'ready';
    /**
     * 🔴 **理由は phase から導く**(#516)。
     * ⚠ 直す前は一律「編集中は使えません」だったので、`phase === 'error'`
     *   (保存に失敗したときの保護)でも同じ字が出ていた ── user は編集して
     *   いないのに「確定するか取り消してください」と言われ、**存在しない編集を探す**。
     * 🔑 字の出どころは `app-state.ts` の 1 か所(§7)。
     */
    const blockedNote = phaseDisabledNote(state.phase) ?? '';

    this.setRow('inspector-title', meta.title);
    this.setRow('inspector-kind', archetypeLabel(meta.archetype));
    /**
     * 🔑 **貼れる 1 行を、押される前に載せておく**(#427 段①)── 押した時に
     *   組み立てると、押してから選択が移った場合に**別のノートの参照**が入る
     *   (`view-asset` が同じ理由で「押した要素から運ぶ」形にしてある)。
     */
    const refBtn = this.buttons.get('copy-entry-ref');
    if (refBtn) {
      refBtn.setAttribute('data-pkc-entry-ref', formatEntryLink(meta.title, meta.lid));
      refBtn.title = '本文に貼ると、このノートへのリンクになります';
    }
    /**
     * ⚠ **持っていないノートでは行ごと畳む**(`<dt>` と `<dd>` を対で)。
     * 🔑 値は**そのまま出す**(知らない状態を黙って捨てない ── `relationLabel` と同じ向き)。
     */
    const statusBox = this.rows.get('inspector-status');
    if (statusBox) {
      const label =
        meta.status === 'open' ? '未完了' : meta.status === 'done' ? '完了' : meta.status;
      statusBox.textContent = label ?? '';
      const none = meta.status === null || meta.status === '';
      statusBox.hidden = none;
      const dt = statusBox.previousElementSibling;
      if (dt instanceof HTMLElement) dt.hidden = none;
    }
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
    /**
     * 🔴 **目次を出す**(#493)。⚠ **本文が読めているときだけ** ── 一覧を眺めて
     * いるだけの状態で「目次 —」を出しても意味が無い。
     * ⚠ **見出しが 0 件なら行ごと畳む**(`<dt>` も一緒に)── PKC2 と同じ作法。
     * 🔑 押すと**本文のその見出しへ飛ぶ**(飛び先の id は `markdown-render` が
     *   同じ `makeSlugCounter` で刻んでいる ── 綴りを 2 か所で作らない)。
     */
    const tocBox = this.rows.get('inspector-toc');
    if (tocBox) {
      const body = state.openBody?.lid === meta.lid ? state.openBody.body : null;
      const headings = body === null ? [] : extractHeadingsFromMarkdown(body);
      tocBox.textContent = '';
      // ⚠ `<dt>` は `<dd>` の直前 ── 値だけ畳むと**見出しだけ残る**(関係の図と同じ)
      const dt = tocBox.previousElementSibling;
      const empty = headings.length === 0;
      tocBox.hidden = empty;
      if (dt instanceof HTMLElement) dt.hidden = empty;
      if (!empty) {
        for (const h of headings) {
          const item = document.createElement('div');
          item.setAttribute('data-pkc-field', 'inspector-toc-item');
          // ⚠ 深さは**属性**で出す(CSS が字下げする)── 空白を字で入れると
          //    読み上げがその空白を読む
          item.setAttribute('data-pkc-toc-level', String(h.level));
          const go = document.createElement('button');
          go.type = 'button';
          go.setAttribute('data-pkc-action', 'toc-jump');
          go.setAttribute('data-pkc-toc-slug', h.slug);
          go.setAttribute('data-pkc-field', 'inspector-toc-link');
          go.title = `本文の「${h.text}」へ移動します`;
          go.textContent = h.text;
          item.append(go);
          tocBox.append(item);
        }
      }
    }
    const tagBox = this.rows.get('inspector-tag-chips');
    const tagBody = state.openBody?.lid === meta.lid ? state.openBody.body : null;
    /**
     * 🔴 **タグを書ける状態か**(#494)。⚠ **1 か所で決める** ── 札の × と
     * 打つ欄で別々に数えると、片方だけ出る形が生まれる(§7)。
     *
     * 3 つとも要る:
     * - **本文が読めている** ── 読めていないのに書くと、その場で組み直した
     *   frontmatter で**元の並びを踏み潰す**
     * - **`ready`** ── `BULK_TAG` は編集中は何もしない(reducer が弾く)ので、
     *   出すと無言の dead click になる
     * - **frontmatter が壊れていない** ── 閉じの `---` を失っている本文に
     *   書き足すと #284 系の実害を広げる(直してから触る)
     */
    const canWriteTags =
      tagBody !== null &&
      state.phase === 'ready' &&
      frontmatterProblem(tagBody)?.kind !== 'unreadable';
    /**
     * 🔴 **理由(`title`)は行そのものに置く**(#494 で器を割ったときに 1 度落とした)。
     *
     * ⚠ 札の入れ物へ付けると、**札が 1 枚も無いとき**(「無し」/「読めていません」)に
     *   指す場所が実質消える ── 理由はまさにそのときに読みたい。
     * 🔑 だから `title` は `dd`(行)、中身は `chips`(札の入れ物)と分ける。
     */
    const tagRow = this.rows.get('inspector-tags');
    if (tagBox) {
      const body = tagBody;
      const tags = body === null ? null : readTags(body);
      /**
       * 🔴 **読めていないときに「無し」と断定しない**(#284)。
       *
       * ⚠ `parseFrontmatter` は読めないときも「そもそも書いていない文書」と
       *   **同じ答え**(`found: false` / `meta: {}`)を返すので、閉じの `---` を
       *   失ったノートに対して、この行は**タグ「無し」と嘘をついていた**
       *   ── すぐ上の「本文が読めていないときは行ごと空(嘘の『タグ無し』を
       *   出さない)」は守られているのに、**対称の反対側だけ空いていた**
       *   (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
       * 🔑 理由は `frontmatterProblem` が 1 行で返す ── ここで
       *   `warnings.some(...)` を書き直さない(判定を 2 か所にしない)。
       * ⚠ 行は狭いので、**画面には短く / 理由は `title` に**(タグの札と同じ作法)。
       */
      const problem = body === null ? null : frontmatterProblem(body);
      tagBox.textContent = '';
      tagRow?.removeAttribute('title');
      /**
       * 🔴 **`trailing` では、実在するタグを隠さない**(2 巡目レビュー A-2)。
       *
       * ⚠ 1 稿目は「理由が在る = 読めていない」と畳んでいたので、
       *   **1 組目が完全に読めるノート**(本文の先頭にもう 1 組らしき行が続くだけ)で
       *   **実在するタグを画面から消して**いた ── #284 の嘘の裏返しを、こちらで
       *   作っていたことになる。
       * 🔑 出せるものは出し、言うべきことは `title` に添える。
       */
      if (problem !== null && problem.kind === 'trailing' && tags !== null) {
        if (tagRow) tagRow.title = problem.detail;
      }
      if (tags === null) {
        tagBox.textContent = '—';
      } else if (problem !== null && problem.kind === 'unreadable') {
        tagBox.textContent = '読めていません';
        if (tagRow) tagRow.title = problem.detail;
      } else if (tags.length === 0) {
        /**
         * 🔴 **`trailing` でも行の字は「無し」のまま**(3 巡目レビュー ②。
         * ⚠ **同日に書いた「行の字にも出す」を、実測で取り下げた判断である**)。
         *
         * 実測:`trailing` は「本文が `---` で始まり、続く ASCII の `key:` の走が
         * 閉じない」で出る。⚠ **健全なノートと #318 の実害形は、構造が同一**である ──
         *
         * | 本文 | 実体 |
         * |---|---|
         * | `---\ntags:…\n---\n---\nTODO: 明日やる` | **健全**(水平線 + 覚書) |
         * | `---\nstatus:…\n---\n---\ntags: [買物]` | **#318 の実害**(2 組目に落ちた) |
         *
         * 見分けられない以上、行の字で**damage だと言い切ってはいけない** ──
         * 健全な側では、user は**存在しない不具合を探しに行く**
         * (CLAUDE.md「常在する警告は、本物の警告を隠す」)。
         * ⚠ しかも「2 組目」は**内部の言葉**である(user は「組」を知らない)。
         *
         * 🔑 実害の側では**タグが消えているという症状が既に見えている**ので、
         *   理由は上で立てた `title` が担う ── 行の字は事実(「無し」)だけにする。
         *   言い切ってよいのは `unreadable`(閉じが無い = **確定**)だけである。
         */
        tagBox.textContent = '無し';
      } else {
        for (const tag of tags) {
          /**
           * 🔴 **札は「探す」と「外す」の 2 つを持つ**(#494)。
           *
           * ⚠ 裁定 2026-08-23「**片道の操作を作らない**」── 打てるのに外せないと、
           *   間違えて付けたタグを消すために**本文を開いて frontmatter を直す**
           *   ことになる(それは動線を 1 つ失うのと同じである)。
           * ⚠ ボタンの中にボタンは置けないので、**包む器**を 1 枚挟む
           *   (関係の行と同じ形 ── 2 つ目の作法を作らない)。
           */
          const chip = document.createElement('span');
          chip.setAttribute('data-pkc-field', 'inspector-tag');
          chip.setAttribute('data-pkc-tag', tag);
          const find = document.createElement('button');
          find.type = 'button';
          find.setAttribute('data-pkc-action', 'filter-by-tag');
          find.setAttribute('data-pkc-tag', tag);
          find.setAttribute('data-pkc-field', 'inspector-tag-find');
          find.title = `「${tag}」を含むノートを探します`;
          find.textContent = tag;
          chip.append(find);
          /**
           * ⚠ **外せるのは、いま書ける状態のときだけ** ── 編集中は本文の正本が
           *   画面側に在るので、`BULK_TAG` は `phase === 'ready'` でしか動かない。
           *   押せない物を出すと無言の dead click になるので、**出さない**。
           */
          if (canWriteTags) {
            const off = iconButton('untag-entry', '外す');
            off.setAttribute('data-pkc-tag', tag);
            off.setAttribute('data-pkc-field', 'inspector-tag-off');
            off.title = `このノートから「${tag}」を外します(ノートも本文の他の行も消えません)`;
            chip.append(off);
          }
          tagBox.append(chip);
        }
      }
    }
    /**
     * 🔴 **本文の中に書いたタグを、どの見出しで付いたかと一緒に出す**(#550)。
     *
     * ⚠ **行ごと畳む**(1 つも無いノートでは出さない)── 右の列は混んでいるので、
     *   常設すると「空の行」を毎回読ませることになる(#500)。
     * ⚠ 本文が読めていないとき(一覧を眺めているだけ)も出さない ── 上の
     *   「タグ」の行と同じ作法で、**知らないことを「無し」と言わない**。
     */
    const bodyTagBox = this.rows.get('inspector-body-tags');
    if (bodyTagBox) {
      const view = tagBody === null ? null : collectEntryTags(tagBody);
      bodyTagBox.textContent = '';
      const dt = bodyTagBox.previousElementSibling;
      const empty = view === null || view.inBody.length === 0;
      bodyTagBox.hidden = empty;
      if (dt instanceof HTMLElement) dt.hidden = empty;
      if (view !== null && !empty) {
        for (const name of view.inBody) {
          const chip = document.createElement('span');
          chip.setAttribute('data-pkc-field', 'inspector-body-tag');
          chip.setAttribute('data-pkc-tag', name);
          const find = document.createElement('button');
          find.type = 'button';
          find.setAttribute('data-pkc-action', 'filter-by-tag');
          find.setAttribute('data-pkc-tag', name);
          find.setAttribute('data-pkc-field', 'inspector-body-tag-find');
          find.title = `「${name}」を含むノートを探します`;
          find.textContent = name;
          chip.append(find);
          /**
           * 🔑 **どこに書いたか**を添える(user 要件の当のもの)。
           * ⚠ 同じタグを何度書いても**場所は畳んで**出す ── 同じ見出しで 3 回書いた
           *   ものを 3 回並べると、読む方が数える羽目になる。
           * ⚠ 見出しの外に書いたものは「(見出しの外)」と言う ── 空欄にすると
           *   「場所が採れなかった」のか「見出しが無い」のかが読めない。
           */
          const where = [
            ...new Set(
              view.uses
                .filter((u) => sameTag(u.name, name))
                .map((u) => (u.heading.length === 0 ? '見出しの外' : u.heading.join(' › '))),
            ),
          ];
          const at = document.createElement('span');
          at.setAttribute('data-pkc-field', 'inspector-body-tag-where');
          at.textContent = `(${where.join(' / ')})`;
          chip.append(at);
          bodyTagBox.append(chip);
        }
      }
    }
    /**
     * 🔴 **打つ欄は「打てるときだけ」出す**(#494)。
     *
     * ⚠ 出しっぱなしにすると、①本文が読めていない(一覧を眺めているだけ)
     *   ②編集中 ③frontmatter が壊れている、のどれでも押せる形になり、
     *   **押しても何も起きない**(無言の dead click)。
     * 🔑 畳む理由は `title` に残す ── 「消えた」ではなく「いまは打てない」と
     *   読めるようにする。
     */
    if (this.tagForm) {
      this.tagForm.hidden = !canWriteTags;
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
          // 🔴 編集中は押せなくする(#513)── reducer は黙って捨てるので、口の側で断る
          del.disabled = editing;
          del.title = editing
            ? `この関係を消します(${blockedNote})`
            : 'この関係を消します(ノートは消えません)';
          item.append(label, go, del);
          relBox.append(item);
        }
      }
    }
    /**
     * 🔴 **このノートを参照しているノート**(#348)。
     *
     * ⚠ **「まだ」と「無い」を区別する** ── `null` は引いている最中であって
     *   0 件ではない。混ぜると「無し」を出したまま結果に追いつかない。
     * ⚠ 相手は**押せる**(辿れないと、一覧しても行き止まりになる ── 関係と同じ)。
     * ⚠ **切ったら言う**(黙って切ると user は「これで全部」と読む)。
     */
    /**
     * 🔴 **どのスマートフォルダに集まっているか**(#283 P1「所属の札」)。
     *
     * ⚠ `smart-tags` は**入れ物の本文**に在るので、これを本当に全数で答えるには
     *   入れ物の数だけ `getBody` が要る ── **選ぶたびに** N 本読むことになる。
     * 🔑 だから**既に集めた結果**(`state.smartHits`)から引く ── あれは
     *   入れ物ごとに「集めた lid の一覧」を持っているので、**この場で同期に**
     *   「自分が入っているか」が言える(I/O ゼロ)。
     *
     * 🔴 **だから「無し」とは絶対に書かない。**
     * ⚠ `smartHits` に居ない入れ物は「集めていない」のではなく
     *   「**まだ集めていない**」だけである ── 「無し」と書くと、
     *   実際には集まっているのに**無いと嘘をつく**。
     * 🔑 分かっているものだけ出し、1 つも無ければ**行ごと畳む**
     *   (すぐ上の「タグ」が「読めていないときは行ごと空」で守っている作法と同じ。
     *   「状態」の行も持たないノートでは畳んでいる)。
     * ⚠ **押すと入れ物へ飛ぶ** ── 「参照元」と同じ `select-entry` を通す
     *   (開く口を増やさない)。
     */
    const smartBox = this.rows.get('inspector-smart');
    if (smartBox) {
      smartBox.textContent = '';
      /** ⚠ 部分的な state(test / 古い保存)では `undefined` になりうる。 */
      const hits = state.smartHits;
      const inside =
        hits === undefined
          ? []
          : [...hits.entries()]
              // ⚠ **自分自身は出さない**(入れ物が自分を集めていても、飛ぶ先にならない)
              .filter(([smartLid, hit]) => smartLid !== meta.lid && hit.lids.includes(meta.lid))
              .map(([smartLid]) => ({
                lid: smartLid,
                title: state.entryMetas.get(smartLid)?.title ?? '(見つかりません)',
              }))
              // 🔑 **並びを決める**(Map の順は集めた順なので、画面が理由なく動く)
              .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
      for (const { lid, title } of inside) {
        const go = document.createElement('button');
        go.type = 'button';
        go.setAttribute('data-pkc-action', 'select-entry');
        go.setAttribute('data-pkc-entry', lid);
        go.setAttribute('data-pkc-field', 'inspector-smart-hit');
        go.textContent = title;
        smartBox.append(go);
      }
      /** ⚠ **行ごと畳む**(`<dt>` も一緒に ── 値だけ消すと空の見出しが残る)。 */
      smartBox.hidden = inside.length === 0;
      const dt = smartBox.previousElementSibling;
      if (dt instanceof HTMLElement) dt.hidden = inside.length === 0;
    }
    const backBox = this.rows.get('inspector-backlinks');
    if (backBox) {
      backBox.textContent = '';
      const back = state.backlinks;
      // ⚠ `null`(まだ引いていない)と `undefined`(その field を持たない state)は
      //    どちらも「**データが無い**」── 片方だけ見ると、部分的な state で落ちる
      if (!back || back.lid !== meta.lid) {
        backBox.textContent = '調べています…';
      } else if (back.lids.length === 0) {
        backBox.textContent = '無し';
      } else {
        for (const otherLid of back.lids) {
          const go = document.createElement('button');
          go.type = 'button';
          go.setAttribute('data-pkc-action', 'select-entry');
          go.setAttribute('data-pkc-entry', otherLid);
          go.setAttribute('data-pkc-field', 'inspector-backlink');
          // ⚠ 相手が消えていても**黙って空にしない**(関係と同じ言い方)
          go.textContent = state.entryMetas.get(otherLid)?.title ?? '(見つかりません)';
          backBox.append(go);
        }
        if (back.truncated) {
          const more = document.createElement('span');
          more.setAttribute('data-pkc-field', 'inspector-backlinks-more');
          more.textContent = `ほかにもあります(${back.lids.length} 件まで出しています)`;
          backBox.append(more);
        }
      }
    }
    /**
     * 🔴 **つながりの図**(#186)。関係(4 種)に加えて、**本文が張っているリンク**も
     * 出す(段③)。
     * ⚠ **点 1 つを図と呼ばない** ── 相手が居なければ行ごと畳む
     *   (「無し」は上の「関係」が既に言っている ── 同じことを 2 回言わない)。
     *
     * ## 🔑 本文のリンクは「新しい問い合わせを 1 つも足さずに」出せる
     *
     * | 向き | どこから取るか | 費用 |
     * |---|---|---|
     * | 出ていく | `state.openBody`(いま開いている本文) | **0**(既に手元にある) |
     * | 入ってくる | `state.backlinks`(#348 で引いている) | **0**(上の「参照元」行と同じ物) |
     *
     * ⚠ **中心の分だけ**である。2 手先のノートが張っているリンクは出ない ──
     *   出すには「N 件の本文を舐める」worker の op が要り、選択のたびに走る。
     *   🔑 **測ってから足す**(founding の「効果が小さいから棄却」ではなく、
     *   「費用を測っていないものを既定にしない」の側)。
     * ⚠ だから図の中で**破線が中心からしか出ていない**のは、そういう仕様である
     *   (「2 手先はリンクを持っていない」ではない)。
     *
     * ⚠ **自己リンクを弾く行は書かない**(2026-08-25、変異試験 L9 が SURVIVED で
     *   教えた)── `buildNeighbourhood` が自己辺を落とすので **no-op** だった。
     *   凡例も `n.edges`(落とした後)を数えるので、件数も嘘にならない。
     *
     * 🔑 **`openBody` の持ち主は見る。** ⚠ ただし「選び替えた直後に前の本文が残る」
     *   からではない ── `SELECT_ENTRY` は `openBody: null` にするので、
     *   **いまの実装ではその状態にならない**(変異試験 L8 が SURVIVED で教えた)。
     *   見る理由は**すぐ上の参照元と同じ**である:この面は
     *   「state がどう作られたか」を知らずに正しくあるべきで、
     *   `backlinks` を `back.lid !== meta.lid` で見ているのと**同じ作法**に揃える。
     *   ⚠ 揃えないと、片方だけ将来の変更に耐える非対称が残る(§7)。
     */
    /**
     * 🔴 **送り先は「開いている窓」1 枚ごとに 1 つ**(同じアプリを 2 枚開いたら 2 つ)。
     * ⚠ 題名が同じ 2 行は見分けにくいが、**送り先が消えるよりはよい** ──
     *   消えるほうは「押せない」ではなく「**押しても違う窓に届く**」形で壊れる。
     */
    const sendBox = this.rows.get('inspector-ext-send');
    if (sendBox) {
      sendBox.textContent = '';
      /**
       * ⚠ **`<dt>` と `<dd>` を対で畳む** ── `<dd>` だけ畳むと、
       *   見出し(「このアプリへ送る」)が中身なしで残る。
       */
      const empty = state.openExtensions.length === 0;
      sendBox.hidden = empty;
      const dt = sendBox.previousElementSibling;
      if (dt instanceof HTMLElement) dt.hidden = empty;
      for (const app of state.openExtensions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-pkc-action', 'deliver-to-extension');
        b.setAttribute('data-pkc-ext-link', app.id);
        b.setAttribute('data-pkc-field', 'inspector-ext-send-app');
        // ⚠ 何が渡るかを**具体**で書く(「連携します」では判断できない)
        b.title = `「${meta.title}」の本文を「${app.title}」へ送ります`;
        b.textContent = app.title;
        sendBox.append(b);
      }
    }

    const mapBox = this.rows.get('inspector-relation-map');
    if (mapBox) {
      const linkEdges: { fromLid: string; toLid: string; kind: string }[] = [];
      const openBody = state.openBody?.lid === meta.lid ? state.openBody.body : null;
      if (openBody !== null) {
        for (const to of bodyLinkTargets(openBody, state.cid)) {
          linkEdges.push({ fromLid: meta.lid, toLid: to, kind: BODY_LINK_KIND });
        }
      }
      const backForMap = state.backlinks;
      if (backForMap && backForMap.lid === meta.lid) {
        for (const from of backForMap.lids) {
          linkEdges.push({ fromLid: from, toLid: meta.lid, kind: BODY_LINK_KIND });
        }
      }
      const drawn = renderRelationMap(mapBox, {
        center: meta.lid,
        depth: 2,
        // ⚠ **居場所(親子)は出さない** ── 上の「関係」行と同じ判断である。
        //    入れると図がフォルダの木になり、「つながり」を見に来た user が
        //    見たい物(意味の関係)が埋もれる。
        edges: [
          ...state.relations
            .filter((r) => r.kind !== STRUCTURAL)
            .map((r) => ({ fromLid: r.fromLid, toLid: r.toLid, kind: r.kind })),
          ...linkEdges,
        ],
        titles: new Map([...state.entryMetas].map(([lid, m]) => [lid, m.title])),
      });
      // ⚠ `<dt>` は `<dd>` の直前 ── 値だけ畳むと**見出しだけ残る**
      const dt = mapBox.previousElementSibling;
      mapBox.hidden = drawn === 0;
      if (dt instanceof HTMLElement) dt.hidden = drawn === 0;
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
    /**
     * 🔴 **いま使われているタグを候補に出す**(#494 段②)。
     *
     * > issue の求め:「**既にあるタグから選べる**(打ち間違いで別のタグを増やさない)」
     *
     * ⚠ **候補は近道であって、打てる語の一覧ではない** ── `<datalist>` は
     *   打った字をそのまま通すので、新しいタグは今までどおり打てる。
     * ⚠ **自分が既に持っているタグは外す** ── 押しても「既に付いています」に
     *   なるだけで、候補の場所を食う。
     * ⚠ 集めるのは**焦点が当たったとき**(`binder` が `ASK_TAG_SUGGESTIONS` を撃つ)
     *   ── ここで頼むと、ノートを選び替えるたびに全走査が走る。
     */
    if (this.tagCandidates) {
      const mine = new Set(tagBody === null ? [] : readTags(tagBody));
      this.tagCandidates.textContent = '';
      for (const t of state.tagSuggestions ?? []) {
        if (mine.has(t)) continue;
        const opt = document.createElement('option');
        opt.value = t;
        this.tagCandidates.append(opt);
      }
    }
    this.setRow('inspector-created', formatStoredDate(meta.createdAt));
    this.setRow('inspector-updated', formatStoredDate(meta.updatedAt));
    this.paintDate(meta, editing, blockedNote);
    this.paintRelationAdd(editing, blockedNote);
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
     * (`editing` の判定は上で 1 度だけ採ってある ── #513)
     */
    /**
     * 🔴 **フォルダ書き出しはフォルダのときだけ**(#399 ①)。
     * ⚠ 出しっぱなしにすると、ノートで押したとき `folderSource` が投げて
     *   「書き出しに失敗しました」と出る ── **押せるのに必ず失敗する**のは、
     *   押せない(畳んである)より悪い。
     */
    const folderBtn = this.buttons.get('export-folder');
    if (folderBtn) folderBtn.hidden = meta.archetype !== 'folder';
    this.paintAdoptImages(state, meta.lid);
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
      const shown = editing ? `${title}(${blockedNote})` : title;
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

  /**
   * 🔴 **外部の画像を取り込むボタンを塗る**(#264 段①)。
   *
   * ⚠ **本文が手元に在るときだけ**数える(`openBody`)── 一覧を眺めているだけの
   *   ときは 0 枚に見えるので**畳む**。⚠ 「0 枚」と書いて出すと、本当に 0 枚の
   *   ノートと**見分けが付かない**(嘘の断定 ── タグ行と同じ罠)。
   *   ⚠ **`null` を `''` に替えても振る舞いは同じ**である(変異試験 M19 が
   *   SURVIVED で教えた ── どちらも 0 枚 = 畳む)。**等価な変異**なので test を
   *   足して殺すことはできない ── 上の 2 行が守っているのは
   *   「**持ち主を見る**」ことであって、`null` という綴りではない。
   * ⚠ **枚数を文言に入れる** ── 押すとその数だけ外へ通信するので、規模を先に見せる。
   *   ⚠ 数えるのは**宛先の数**である(同じ URL が 2 回出ても 1)。
   */
  private paintAdoptImages(state: AppState, lid: string): void {
    const b = this.buttons.get('adopt-external-images');
    if (!b) return;
    const body = state.openBody?.lid === lid ? state.openBody.body : null;
    let count = 0;
    if (body === null) {
      // ⚠ **憶えたものを手放す**(不可侵指示 2026-07-27「ライフサイクル終端での
      //   速やかな破棄」)── 本文を閉じたあとも文字列を握っていると、
      //   1 件ぶんの本文が常駐したままになる。
      //   ⚠ **この 1 行は画面を 1 ドットも変えない** ── 外しても畳みも枚数も
      //   同じなので、test では守れない(守っているのは常駐メモリだけである)。
      this.imgCount = null;
    } else {
      if (this.imgCount?.body !== body) {
        this.imgCount = { body, count: externalImageUrls(body).length };
      }
      count = this.imgCount.count;
    }
    b.hidden = count === 0;
    if (count === 0) return;
    // ⚠ 字を入れるのは**札の span** ── ボタン自身に入れると図案ごと消える
    //    (`iconButton` が `data-pkc-field="label"` で作っている)
    const label = b.querySelector<HTMLElement>('[data-pkc-field="label"]');
    if (label) setText(label, `外部の画像を取り込む(${count} 枚)`);
  }

  /** 値を入れる。⚠ 器に無い field を書こうとしたら形の宣言が漏れている。 */
  private setRow(field: string, value: string): void {
    const dd = this.rows.get(field);
    if (dd) setText(dd, value);
  }

  /**
   * 🔴 **ノート 1 件の日付**を塗る(#292 段④)。
   *
   * ⚠ **「置けるなら外せる」** ── 付ける口だけ出すと、間違えて付けた日付を
   *   本文の frontmatter を開いて手で消すまで戻せない(片道を作らない)。
   * ⚠ 器は使い回す(押す寸前のボタンを作り直さない)。
   */
  private paintDate(meta: EntryMeta, editing: boolean, blockedNote: string): void {
    const dd = this.rows.get('inspector-date');
    if (!dd) return;
    let set = dd.querySelector<HTMLButtonElement>('[data-pkc-action="set-entry-date"]');
    let clear = dd.querySelector<HTMLButtonElement>('[data-pkc-action="clear-entry-date"]');
    if (set === null) {
      set = document.createElement('button');
      set.type = 'button';
      set.setAttribute('data-pkc-action', 'set-entry-date');
      clear = document.createElement('button');
      clear.type = 'button';
      clear.setAttribute('data-pkc-action', 'clear-entry-date');
      clear.textContent = '外す';
      dd.append(set, clear);
    }
    const has = meta.date !== null;
    // 🔑 日付の見せ方は `formatStoredDate` 1 本(一覧・情報列と同じ規則)
    const label = has ? formatStoredDate(meta.date) : '日付を付ける';
    if (set.textContent !== label) set.textContent = label;
    /**
     * 🔴 編集中は押せなくする(#513)── 直す前はピッカーの全手順(開く → 選ぶ →
     * 確定)を**完走させてから**reducer が黙って捨てていた。
     */
    set.disabled = editing;
    const setBase = has ? '日付を選び直します' : 'このノート 1 件を、その日の予定にします';
    set.title = editing ? `${setBase}(${blockedNote})` : setBase;
    // ⚠ **押しても何も起きないボタンを出さない**(日付が無ければ外すものが無い)
    if (clear) {
      clear.hidden = !has;
      clear.disabled = editing;
      clear.title = editing
        ? `日付を外します(${blockedNote})`
        : '日付を外します(ノートは消えません)';
    }
  }

  /**
   * 🔴 関係を足す帯も編集中は押せなくする(#513)。
   * ⚠ この帯は操作の帯の loop(`this.buttons`)の**対象外**なので、個別に塗る ──
   *   直す前は編集中も押せて、reducer が黙って捨て、**欄だけ空になっていた**。
   */
  private paintRelationAdd(editing: boolean, blockedNote: string): void {
    const bar = this.relAdd;
    if (!bar) return;
    bar.target.disabled = editing;
    bar.kind.disabled = editing;
    bar.add.disabled = editing;
    const base = '選んでいるノートから、相手のノートへ関係を張ります';
    bar.add.title = editing ? `${base}(${blockedNote})` : base;
  }

  /** 器を組む(形が変わったときだけ呼ばれる)。 */
  private build(shape: Shape): void {
    this.region.textContent = '';
    this.rows = new Map();
    this.buttons = new Map();
    this.relAdd = null;

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
      // 🔴 **タグの行だけは器を 2 つに割る**(#494)── 下の注記を参照
      if (field === 'inspector-tags') {
        const chips = document.createElement('span');
        chips.setAttribute('data-pkc-field', 'inspector-tag-chips');
        const form = document.createElement('span');
        form.setAttribute('data-pkc-field', 'tag-add');
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('data-pkc-field', 'tag-add-input');
        input.setAttribute('list', 'pkc-tag-candidates');
        input.placeholder = 'タグを打つ';
        input.setAttribute('aria-label', 'このノートに足すタグ');
        const cands = document.createElement('datalist');
        cands.id = 'pkc-tag-candidates';
        this.tagCandidates = cands;
        const add = iconButton('add-tag', 'タグを足す');
        add.title = 'このノートの本文にタグを足します(frontmatter の tags: に入ります)';
        form.append(input, cands, add);
        dd.append(chips, form);
        this.rows.set('inspector-tag-chips', chips);
        this.tagForm = form;
      }
    };
    row('題名', 'inspector-title');
    row('種類', 'inspector-kind');
    /**
     * 🔴 **状態**(#397 ③)。⚠ `todo` フレーバーが frontmatter から
     *   `status` を**抽出して `entryMetas` に載せていた**のに、
     *   **それを読む画面が 1 つも無かった**(`grep -rn "\.status\b"` が
     *   一覧・情報ペイン・絞り込みで 0 件)── 取り込んだ todo の完了 / 未完了が
     *   **どこにも出ていなかった**。
     * ⚠ 封印(`features/sealed.ts`)が止めているのは **todo の新規作成**であって、
     *   **既に status を持っているノートの表示**ではない。データは実在する。
     * ⚠ 持っていないノートでは**行ごと畳む**(全ノートに「無し」を出さない)。
     */
    row('状態', 'inspector-status');
    row('居場所', 'inspector-folder');
    row('作成', 'inspector-created');
    row('更新', 'inspector-updated');
    /**
     * 🔴 **ノート 1 件の日付**(#292 段④。frontmatter の `date:`)。
     *
     * ⚠ 直す前、これを書く口は**カレンダーの日を押すこと 1 つ**だった
     *   ── だから「日を押す前に、左の一覧からノートを選んでください」という
     *   帯が要り、user は**本文を退かして**日付を付けていた(①の実害)。
     * 🔑 いまは掴んで落とすのが主の道(予定の面)。ここは
     *   **まだ日付が無くて掴む札が無いとき**のための口である。
     * ⚠ 右の列に置くのは規則どおり(`browse.ts` の表:**右 = 選んでいるもの**)──
     *   ノートの日付は、まさに選んでいるノートの属性である。
     * ⚠ 値は押せるボタンなので `setRow` ではなく専用の器を持つ。
     */
    row('日付', 'inspector-date');
    /**
     * 🔴 **見出しから自動で作る目次**(#493)。
     *
     * > user 報告 2026-08-27:「**自動で見出しから生成された TOC が PKC2 にはあるけど、
     * > PKC3 にはない**」
     *
     * ⚠ 「無い」のではなく「**手で `:::toc` と書かないと出ない**」だった ──
     *   見出しの拾い出し(`extractHeadingsFromMarkdown`)も、h1〜h3 への id 刻みも
     *   既に在り、**受け手だけが未実装**だった。実際 `markdown-render.ts` の
     *   id を刻む節には「**right-pane の目次が飛べるように**」と書いてある。
     *
     * 🔑 **置き場は PKC2 が答えを持っていた** ── 好みで決めていない。
     *   PKC2 は `renderer.ts:9056` で **meta ペイン(= 右の列)** に置き、
     *   **見出しが 0 件なら丸ごと出さない**形だった(`docs/development/
     *   table-of-contents-right-pane.md`)。user が既に知っている絵に揃える。
     * ⚠ 右の列は混んでいる(#500)ので、**見出しを持たないノートでは行ごと畳む** ──
     *   常設すると「押せない物」を毎回読ませることになる(#300 の小さい版)。
     * ⚠ 値は押せる札なので `setRow` ではなく専用の器を持つ。
     */
    row('目次', 'inspector-toc');
    /**
     * 🔴 **タグ**(#182 / 台帳 #180 の A-2)。⚠ 値は文字ではなく**押せる札**なので、
     * `setRow`(textContent 差し替え)ではなく専用の器を持つ。
     */
    row('タグ', 'inspector-tags');
    /**
     * 🔴 **本文の中に書いたタグ**(#550。user 要望 2026-08-29
     *   「**どの見出しや記事でタグがついたのかわかりやすくすべき**」)。
     *
     * ⚠ 上の「タグ」の行は **frontmatter だけ**を出す ── だから本文に
     *   `#買い物` と書いて札が出ているノートでも、右の列は「**無し**」と言っていた
     *   (2026-08-29 の着地後レビューで確定。**札の隣で嘘をつく**形)。
     * 🔑 だから**別の行**にする ── user の要件は「2 種類を分ける」ことなので、
     *   混ぜて 1 つにしない。
     * ⚠ **「外す」は付けない** ── 外す口(`untag-entry`)は frontmatter しか
     *   書き換えないので、本文のタグに付けると
     *   「**0 件に外しました / 1 件は付いていませんでした**」という嘘の帯が出る。
     *   本文に書いたものは本文で消す(そのために**どこに書いたか**を出す)。
     * ⚠ 見出しへ**飛ばさない** ── 同じ見出しが 2 つあるノートで**別の場所へ飛ぶ**。
     *   見出しで飛ぶのは、すぐ上の「目次」の行が担っている。
     */
    row('本文のタグ', 'inspector-body-tags');
    /**
     * 🔴 **タグを「その場で打つ」**(#494。user 指摘 2026-08-27
     * 「**直感的にここにタグを打つ!って感じの動作じゃなくて yamlfrontmatter なのは
     * 問題だ。しかも設定動線がよくわからん**」)。
     *
     * ⚠ **打つ口が無かったわけではない** ── 数えたら 3 経路あった:
     *   ①本文の frontmatter に書く ②フォルダの面で行に印を付けて「タグを付ける」
     *   ③スマートフォルダへ掴んで落とす。🔴 **どれも「いま開いているこのノート」の
     *   口ではない** ── ②は別の面へ移って印を付ける必要があり、③は入れ物が要る。
     *   ⚠ そして情報ペインのタグ行は**読み取り専用**だった(押すと「探す」だけ)。
     *   だから user には「無い」に見えた ── **見つけられないのはこちらの動線の
     *   不備であって、user の落ち度ではない**。
     *
     * 🔑 裁定 2026-08-23「**面は『映すだけ』にしない ── 双方向を既定にする**」の
     *   とおり、**映している行そのものに打つ口を置く**(別の帯へ離すと、
     *   「どこで打つのか」を探す動線がまた 1 つ増える)。
     *
     * ⚠ **器は 2 つに割る** ── 札は描き直しのたびに作り直すが、**打つ欄は
     *   作り直さない**(作り直すと打ちかけの字と focus が消える ── 追記欄と
     *   同じ理由。P8 段⑧)。
     */
    /**
     * 🔴 **どのスマートフォルダに集まっているか**(#283 P1「所属の札」)。
     *
     * ⚠ **タグの札とは別物**である ── タグの札は「その語で探す」、こちらは
     *   「**このノートが実際に並んでいる入れ物**」へ飛ぶ。
     * 🔑 **user には自力で計算できない** ── 入れ物は条件を複数持てる
     *   (`smart-tags: [請求, 未処理]`)ので、自分のタグを見ても
     *   「どこに集まっているか」は分からない。
     * ⚠ 値は押せる札なので `setRow` ではなく専用の器を持つ。
     */
    row('集まり先', 'inspector-smart');
    /**
     * 🔴 **関係**(#185 / 台帳 #180 の A-7)。⚠ 親子(居場所)は上の「居場所」行が
     * 既に出しているので、ここは**それ以外**(関連 / 分類 / 時系列 / 出典)を出す。
     * ⚠ 値は押せる札 + 消すボタンなので、`setRow` ではなく専用の器を持つ。
     */
    row('関係', 'inspector-relations');
    /**
     * 🔴 **このノートを参照しているノート**(#348、user 裁定 2026-08-23)。
     *
     * ⚠ 上の「関係」と**別物**である ── あちらは user が手で張った辺、
     *   こちらは**本文に書いたリンク**(`entry:<lid>`)から自動で拾ったもの。
     *   だから**消すボタンは置かない**(消すには本文のリンクを消す)。
     * 🔑 **中央の面は奪わない** ── 右の列に置くのは規則どおり
     *   (`browse.ts` の表:右 = 選んでいるもの)。
     */
    row('参照元', 'inspector-backlinks');
    /**
     * 🔴 **つながりの図**(#186 / 台帳 #180 の A-6)。
     *
     * ⚠ 上の「関係」は**一覧**、ここは**形**である ── 一覧では
     * 「どれとどれが繋がっているか」(相手同士の関係)が読めない。
     * 🔑 **右の列に置く**のは規則どおり(`browse.ts` の表:右 = 選んでいるもの)
     * ── 選択に自動で追従するので、別窓に出すときの同期の仕掛けが要らない。
     * ⚠ **中央の面は奪わない**(#300 で user が叱った型)。
     */
    row('つながり', 'inspector-relation-map');
    /**
     * 🔴 **開いている拡張へ、いま見ているノートを送る**(#195 / C-5 段②-b)。
     *
     * ⚠ **1 つも開いていないときは行ごと出さない** ── 「送り先がありません」を
     *   常設すると、user は**押せない物**を毎回読むことになる(#300 で叱られた
     *   「主の作業領域を邪魔する」の小さい版)。
     * 🔑 置き場が右の列なのは規則どおり(`browse.ts` の表:右 = 選んでいるもの)
     *   ── 送るのは**いま選んでいる 1 件**なので、選択に自動で追従する。
     *
     * ⚠ **器はここで 1 度だけ組む**(この file の作法)。1 つも開いていないときは
     *   **行ごと畳む** ── 「送り先がありません」を常設すると、user は
     *   **押せない物**を毎回読むことになる。畳みは `paintExtSend` が決める。
     */
    row('このアプリへ送る', 'inspector-ext-send');
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
    this.relAdd = { target, kind, add };

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
    /**
     * 🔴 **このノートの参照をコピー**(#427 段①)。
     *
     * ⚠ 直す前は **PKC3 の中で新しくリンクを張る道が無かった** ── マニュアルは
     *   `[題名](entry:<lid>)` と案内しているのに、**`<lid>` を知る手段が画面に
     *   1 つも無い**(この面は id を出さないし、`copy-` の action 7 つのうち
     *   ノート自身の参照を出すものが 1 つも無かった)。
     * 🔑 **添付の「参照をコピー」と同じ形**にする ── 貼れる 1 行を
     *   `data-pkc-entry-ref` に載せ、binder はそれを渡すだけ(組み立て直さない)。
     */
    btn('copy-entry-ref', ENTRY_ACTION_LABELS['copy-entry-ref']!);
    /**
     * 🔴 **外部の画像を手元へ取り込む**(#264 段①)。
     *
     * ⚠ **1 枚も無いときは畳む**(`paintAdoptImages`)── `export-folder` と同じ作法。
     *   常設すると「押しても何も起きない物」を毎回読ませることになる。
     * ⚠ **文言に枚数を入れる** ── 押すと**その枚数ぶん外へ通信する**ので、
     *   押す前に規模が分かる形にする(#264 の棄却理由②)。
     */
    btn('adopt-external-images', '外部の画像を取り込む');
    btn('export-entry', ENTRY_ACTION_LABELS['export-entry']!);
    /**
     * 🔴 **相手に渡せる 1 枚**(#491)。
     *
     * > user 報告 2026-08-27:「右クリックで気づきましたが、
     * > **書き出しに閲覧配布用HTMLがないのは残念**ですね」
     *
     * ⚠ 在ったのは**設定 → 書き出しと片づけ**の「閲覧用 HTML」だけで、
     *   それは**コレクション全部**を 1 枚にする物だった ── ノート 1 件を
     *   渡す口は**どこにも無かった**。
     * 🔑 隣の `書き出す` の真横に置く ── 「渡したい」と思った人が
     *   最初に見るのはこの群れである。
     */
    btn('export-entry-html', ENTRY_ACTION_LABELS['export-entry-html']!);
    /**
     * 🔴 **このフォルダごと書き出す**(#399 ①)。
     *
     * ⚠ **フォルダのときだけ出す**(`render` で `hidden` を付け外しする)──
     *   形(`Shape`)を増やすと `entry+link` との掛け算になり、組み直しが増える。
     * ⚠ **消さずに畳む**のは、隣の並びを動かさないためである(業務画面の作法
     *   「同じものが常に同じ場所にある」)。
     */
    btn('export-folder', 'フォルダを書き出す');
    // 🔴 **Word で出す**(#187 段①)。⚠ 隣の「書き出す」と**別の物**である ──
    //    あちらは取り込み直せるバックアップ、こちらは片道の Word 文書
    btn('export-entry-docx', ENTRY_ACTION_LABELS['export-entry-docx']!);
    /**
     * 🔴 **PowerPoint で出す**(#187 段⑤)。⚠ Word と**切れ方が違う** ──
     *   見出しでスライドが切れるので、説明にもそう書く(押す前に分かるように)。
     */
    btn('export-entry-pptx', ENTRY_ACTION_LABELS['export-entry-pptx']!);
    /**
     * 🔴 **紙に出す(= PDF)**(#187、2026-08-23)。⚠ 隣の 2 つと違い、
     *   **file は落ちない** ── ブラウザの印刷画面が開き、そこで user が
     *   「PDF として保存」を選ぶ。⚠ だから文言に「保存します」と書かない。
     */
    btn('export-entry-pdf', ENTRY_ACTION_LABELS['export-entry-pdf']!);
    /**
     * 🔴 **素の Markdown で写す**(#396)。
     *
     * > user 明示要望(PKC2 に記録):「方言記法されたエントリから
     * > ベーシックなマークダウンだけを取り出す機能」
     *
     * ⚠ PKC2 では**押せる口がどこにも無かった**(拡張の RPC の option だけ)──
     *   実装は在ったが**届いていなかった**。ここが PKC3 の動線である。
     * ⚠ 隣の 4 つと違い、**file は落ちない**(clipboard へ写す)── 他のツールへ
     *   そのまま貼るための物だからである。
     */
    btn('copy-plain-markdown', ENTRY_ACTION_LABELS['copy-plain-markdown']!);
    if (shape === 'entry+link') btn('write-back-file', '書き戻す');
    btn('show-history', ENTRY_ACTION_LABELS['show-history']!);
    btn('delete-entry', ENTRY_ACTION_LABELS['delete-entry']!);
    this.region.append(actions);
  }
}

/**
 * 押せる操作の説明。⚠ **1 か所に持つ** ── 器を組む所と値を入れる所に別々に
 * 書くと、片方だけ古くなる(この repo が何度も踏んでいる形)。
 */
const ACTION_TITLES: Record<string, string> = {
  'export-entry': 'このノートだけをバックアップ形式(.pkc3.zip)で保存します。取り込み直せます',
  // 🔴 **`export-entry` との違いを説明で言い切る**(#400 段④ と同じ作法)──
  //    どちらも「1 ノートを 1 file にする」ので、**何が違うか**を書かないと選べない
  'export-entry-html':
    'このノートを、ブラウザで開くだけで読める 1 枚の .html にします。PKC3 を持っていない相手にも渡せます。片道です(取り込み直せません)',
  // ⚠ **画面で起きることで書く**(user 指示 2026-08-21)── 「配下を再帰収集」ではなく
  //    「中に入っているものごと」。⚠ **外へ繋がる関連が落ちる**ことも先に言う
  'export-folder':
    'このフォルダと、中に入っているものをまとめてバックアップ形式(.pkc3.zip)で保存します。取り込み直せます(外へ繋がる関係は入りません)',
  // 🔴 **実装に合わせる**(2026-08-18)。直す前は「この版では画像は入りません」と
  //    書いてあったが、画像も図もグラフも**入る**(`features/export/docx.ts` の VML /
  //    `svg-emf.ts` のベクタ)。マニュアル(§5)もお知らせ 2 件も「入る」と言っており、
  //    ⚠ **画面の説明だけが古いまま user に嘘をついていた**(押すのを諦めさせる向き)。
  'export-entry-docx':
    'このノートを Word 文書(.docx)で保存します。片道です(画像も、図はベクタで、グラフは絵で入ります)',
  // ⚠ **切れ方を先に言う**(user 指示 2026-08-21「画面で何が起きるかで書く」)──
  //    押してから「なぜ 12 枚もあるのか」と思わせない
  'export-entry-pptx':
    'このノートを PowerPoint(.pptx)で保存します。片道です。大見出し(#)が扉、中見出し(##・###)と `---` でスライドが切れます',
  // ⚠ **起きることを書く**(user 指示 2026-08-21「画面で何が起きるかで書く」)──
  //    押すと**ブラウザの印刷画面**が開く。PDF にするかはそこで user が選ぶ
  'export-entry-pdf':
    'このノートを紙の形に組んで、ブラウザの印刷画面を開きます。そこで「PDF として保存」を選べます(紙の大きさは設定で変えられます)',
  // 🔴 **押すと外へ通信する**ことを先に言う(user 指示 2026-08-21「画面で何が起きるかで書く」)
  //    ⚠ 「取り込みます」だけだと、**押した瞬間に相手のサーバーへ要求が飛ぶ**ことが読めない
  'adopt-external-images':
    '本文の外部の画像を、その置き場所から読んでこのノートの添付にします。押すとその置き場所へ通信します。読めたものだけ本文が添付を指すように変わります(読めなかったものは元の URL のまま残り、理由が出ます)',
  'show-history': '過去の版を一覧します',
  'delete-entry': 'ゴミ箱へ移します(フォルダ画面から戻せます)',
};

/** 「書き戻す」だけは行き先(ファイル名)を文言に含める。 */
function whyWriteBack(link: string | null): string {
  return `開いた元のファイル(${link ?? ''})を、このノートの内容で上書きします`;
}
