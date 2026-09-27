/**
 * 🔴 **章の別ウィンドウ(読むだけ)の判断と追従**(#1044 段4)。
 *
 * 設計: `docs/development/section-edit-design-2026-09.md` §10。窓の DOM を組む手は
 * `adapter/platform/chapter-window.ts`、ここが持つのは**何を出すか**と**いつ組み直すか**。
 *
 * ## 🔑 章は「見出しの字 + 何番目か」で追う
 *
 * 開いた瞬間に押した見出しを `headingRefAt` で覚え、組み直すたびに**いまの本文から**
 * `chapterLinesOf` で引き直す(章の欄と同じ 2 本 ── §7)。⚠ 行番号で追うと、上に行が
 * 足されただけで**別の章**を出す(PKC2 の章の窓がそうだった)。
 *
 * ## 🔑 中身は本体と同じ描画で**全文**を描き、章の塊だけを移す
 *
 * ⚠ 章の原文だけを描くと、見出しの番号・見出しの id・`{{vars}}` が全文の描画と食い違う。
 * 🔑 塊の拾い方は章の欄と同じ `blocksInRange`(`data-pkc-source-line` で直下の塊)。
 * ⚠ 押せる形の旗(`interactive*`)は渡さない(`readingRenderOptions` はそれを持たない)。
 *
 * ## 🔴 組み直す合図(§10.3)
 *
 * | 何が変わったか | 読む本文 |
 * |---|---|
 * | 本体でそのノートを開いていて、読む状態の本文が変わった | 本体の本文(保存より先に届く) |
 * | そのノートの保存の時刻・題名が変わった(別のタブ・別のウィンドウの書込を含む) | 保存先から読み直す |
 * | ノートが消えた | 「このノートはもうありません」 |
 * ⚠ **本体でそのノートを全文編集している間は、打ちかけを映さない**(確定して読む状態に
 *   戻ったときに組み直す)── 保存していない字を「読むだけの窓」に出さない。
 *
 * ## 🔴 ObjectURL は窓を閉じたら・組み直したら返す(不可侵指示 2026-07-27)
 *
 * ⚠ 別の窓の close は event で飛んでこない ── 見張り(`poll`)で気づく。同じ見張りで
 *   **F5 で白くなった**ことにも気づき、組み直す(空の窓は F5 で白紙に戻る)。
 *   ⚠ 窓ごとに timer を 2 本立てない ── 閉じた / 白くなった を 1 本で見る。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  chapterLinesOf,
  headingRefAt,
  type ChapterLines,
  type HeadingRef,
} from '@features/markdown/append-target';
import { bodyBelowFrontmatter } from '@features/markdown/frontmatter';
import {
  renderFenceFromAsset,
  renderMarkdown,
  type RenderMarkdownOptions,
} from '@features/markdown/markdown-render';
import {
  applyDocumentGlobals,
  extractDocumentGlobals,
} from '@features/markdown/document-globals';
import { readFenceAssetText } from '@features/asset/fence-asset-read';
import {
  chapterWindowBuilt,
  chapterWindowName,
  grabChapterWindow,
  markChapterWindowOrphaned,
  paintChapterWindow,
  wireChapterWindow,
  CHAPTER_WINDOW_TEXT,
  type ChapterWindowContent,
} from '@adapter/platform/chapter-window';
import { blocksInRange } from './render/section-box';
import { hydrateFigures, readingRenderOptions } from './render/detail';
import type { MermaidScope } from './render/mermaid-hydrate';

/** 窓が開けなかったとき(`view-window.ts` と同じ字)。 */
export const CHAPTER_WINDOW_BLOCKED = 'ブラウザが新しいウィンドウをブロックしたようです';

/** 押した見出しを読めなかったとき(押した直後に本文が変わった等)。 */
export const CHAPTER_HEADING_UNREADABLE = '見出しを読めませんでした(もう一度右クリックしてください)';

export interface ChapterWindowsDeps {
  readonly getState: () => AppState;
  /** 保存先から本文を読む(本体で開いていないノート / 別の窓の書込の後)。 */
  readonly getBody: (lid: string) => Promise<string | null>;
  /** 本体と同じ描画の口(`MarkdownClient.render`)。 */
  readonly render: (text: string, opts: RenderMarkdownOptions) => Promise<string>;
  /** そのノートで外部の画像を出してよいか(本体と同じ判定)。 */
  readonly allowExternalImages: (lid: string) => boolean;
  /** 添付を借りる(`assetLender`)。 */
  readonly lend: (key: string) => Promise<{ url: string; dispose: () => void } | null>;
  readonly getBlob: (key: string) => Promise<Blob | null>;
  /** 窓の中で押された口を、開いた側で走らせる(`runChapterWindowAction`)。 */
  readonly runAction: (el: HTMLElement) => void;
  /** 理由を出す(開けなかった等)。 */
  readonly fail: (message: string) => void;
  /** 素の別窓を開く(既定 `window.open`)。⚠ test が差せる。 */
  readonly open?: (url: string, target: string, features: string) => Window | null;
  /** 図の後付け(既定は本文の面と同じ `hydrateFigures`)。⚠ test が差せる。 */
  readonly hydrateFigures?: (roots: readonly ParentNode[]) => MermaidScope[];
  /** 見張りの時計。⚠ test が差せる。 */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (h: unknown) => void;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (h: unknown) => void;
}

/** 見張りの間隔(閉じた / F5 で白くなった に気づくまで)。 */
const POLL_MS = 1000;
/** 組み直しをまとめる間(打鍵のように続けて変わるとき、1 回にする)。 */
const DEBOUNCE_MS = 150;

interface OpenChapter {
  readonly win: Window;
  readonly lid: string;
  readonly ref: HeadingRef;
  readonly name: string;
  /** 組み直しの世代(遅れて返った描画を当てない)。 */
  gen: number;
  /** 最後に見た合図(`signatureOf`)。 */
  sig: string;
  /** 借りた添付・図の後始末。 */
  disposers: Array<() => void>;
  pending: unknown;
}

export class ChapterWindows {
  private readonly windows = new Map<string, OpenChapter>();
  private poll: unknown = null;
  private orphaned = false;

  constructor(private readonly deps: ChapterWindowsDeps) {}

  /** いま開いている章の窓の数(test の観測点)。 */
  get size(): number {
    return this.windows.size;
  }

  /**
   * 🔴 **押した見出しの章を、別のウィンドウで開く**。⚠ **同期で**窓を掴む
   *   (user の操作の続きでしか開けない ── `await` の後に開くとポップアップ阻止に掛かる)。
   *
   * @param lid 押した見出しのノート(本体でいま開いているもの)
   * @param line 押した見出しの行(frontmatter を剥がした側 ── 右クリックが運ぶ値)
   */
  open(lid: string, line: number): boolean {
    const st = this.deps.getState();
    const body = st.openBody?.lid === lid ? st.openBody.body : null;
    const ref = body === null ? null : headingRefAt(body, line);
    if (body === null || ref === null) {
      this.deps.fail(CHAPTER_HEADING_UNREADABLE);
      return false;
    }
    const name = chapterWindowName(lid, ref);
    const win = grabChapterWindow(name, this.deps.open);
    if (win === null) {
      // ⚠ 本体の中央へ退避しない(付箋と同じ ── CLAUDE.md「別窓が塞がれたときの退避先を、中央にしない」)
      this.deps.fail(CHAPTER_WINDOW_BLOCKED);
      return false;
    }
    let o = this.windows.get(name);
    if (o === undefined || o.win !== win) {
      if (o !== undefined) this.dispose(o);
      o = { win, lid, ref, name, gen: 0, sig: '', disposers: [], pending: null };
      this.windows.set(name, o);
      // ⚠ 開いた瞬間に「待っている」と分かる形にする(白紙を見せない)
      paintChapterWindow(win, {
        title: titleOf(st, lid, ref.text),
        noteTitle: noteTitleOf(st, lid),
        key: name,
        content: { kind: 'loading' },
      });
    }
    try {
      win.focus();
    } catch {
      // 前へ出せない環境が在る
    }
    // 🔑 2 回目に押したときも**いまの本文で組み直す**(PKC2 は手前へ出すだけで古いままだった)
    void this.repaint(o);
    this.ensurePoll();
    return true;
  }

  /**
   * 状態が変わるたびに呼ぶ(`dispatcher.onState`)。合図が変わった窓だけ組み直す。
   * ⚠ 続けて変わるとき(保存の ack が続けて返る等)は `DEBOUNCE_MS` でまとめる。
   */
  onState(state: AppState): void {
    if (this.orphaned) return;
    for (const o of this.windows.values()) {
      if (signatureOf(state, o.lid) === o.sig) continue;
      this.schedule(o);
    }
  }

  /**
   * 🔴 **元のウィンドウが閉じる**(`pagehide` で `persisted` でないとき)。
   * ⚠ 追従する側が居なくなるので、窓に言う(黙って古くならない)。
   */
  orphanAll(): void {
    this.orphaned = true;
    for (const o of this.windows.values()) markChapterWindowOrphaned(o.win);
    this.stopPoll();
  }

  private schedule(o: OpenChapter): void {
    const setT = this.deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const clearT = this.deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (o.pending !== null) clearT(o.pending);
    o.pending = setT(() => {
      o.pending = null;
      void this.repaint(o);
    }, DEBOUNCE_MS);
  }

  /** いまの本文で組み直す。⚠ 遅れて返った描画は当てない(`gen`)。 */
  private async repaint(o: OpenChapter): Promise<void> {
    const gen = ++o.gen;
    const st0 = this.deps.getState();
    // ⚠ 合図は**読む前に**控える ── 読んでいる間に変わった分は、次の onState が拾う
    o.sig = signatureOf(st0, o.lid);
    if (!st0.entryMetas.has(o.lid)) {
      this.paint(o, st0, o.ref.text, { kind: 'gone' });
      return;
    }
    const ready = readyBodyOf(st0, o.lid);
    let body: string | null;
    try {
      body = ready ?? (await this.deps.getBody(o.lid));
    } catch {
      body = null;
    }
    if (gen !== o.gen || o.win.closed) return;
    const st = this.deps.getState();
    if (body === null) {
      this.paint(o, st, o.ref.text, { kind: 'gone' });
      return;
    }
    const lines = chapterLinesOf(body, o.ref);
    if (lines === null) {
      this.paint(o, st, o.ref.text, { kind: 'missing' });
      return;
    }
    const opts = readingRenderOptions(body, {
      allowExternalImages: this.deps.allowExternalImages(o.lid),
      currentContainerId: st.cid ?? '',
    });
    const shown = bodyBelowFrontmatter(body);
    let html: string;
    try {
      html = await this.deps.render(shown, opts);
    } catch {
      // ⚠ ワーカーは速さの話であって正しさの話ではない(本文の面と同じ倒し方)
      html = renderMarkdown(shown, opts);
    }
    if (gen !== o.gen || o.win.closed) return;
    const host = this.paint(o, this.deps.getState(), lines.text, {
      kind: 'chapter',
      blocks: chapterBlocks(html, lines),
      jumpRef: `entry:${o.lid}#h/${lines.slug}`,
    });
    if (host === null) return;
    applyDocumentGlobals(host, extractDocumentGlobals(body));
    await this.hydrate(o, gen, host, opts);
  }

  private paint(
    o: OpenChapter,
    st: AppState,
    heading: string,
    content: ChapterWindowContent,
  ): HTMLElement | null {
    // 🔴 **組み直す前に、前の中身が借りていた物を返す**(画面から消える `<img>` のぶん)
    this.release(o);
    const host = paintChapterWindow(o.win, {
      title: titleOf(st, o.lid, heading),
      noteTitle: noteTitleOf(st, o.lid),
      key: o.name,
      content,
    });
    wireChapterWindow(o.win, this.deps.runAction);
    return host;
  }

  /**
   * 画像・添付から中身を取る枠・図を埋める(本文の面と同じ関数を、窓ごとの寿命で)。
   * ⚠ 待っている間に組み直された・閉じた なら、借りた物は**その場で返す**。
   */
  private async hydrate(
    o: OpenChapter,
    gen: number,
    host: HTMLElement,
    env: { readonly allowExternalImages: boolean; readonly currentContainerId: string },
  ): Promise<void> {
    const stale = (): boolean => gen !== o.gen || o.win.closed;
    // ① 添付から中身を取る枠(#444)── 描けたら図もその中で埋める
    const fences = Array.from(host.querySelectorAll<HTMLElement>('[data-pkc-fence-asset-key]'));
    await Promise.all(
      fences.map(async (h) => {
        const key = h.getAttribute('data-pkc-fence-asset-key') ?? '';
        const got = await readFenceAssetText(this.deps.getBlob, key);
        if (stale()) return;
        const pending = h.querySelector('[data-pkc-fence-asset-pending]');
        if (!got.ok) {
          if (pending) {
            pending.setAttribute('data-pkc-fence-asset-error', '');
            pending.removeAttribute('data-pkc-fence-asset-pending');
            pending.textContent = `このコードブロックの中身(添付)を読み込めません: ${got.why}`;
          }
          return;
        }
        const holder = document.createElement('div');
        holder.innerHTML = renderFenceFromAsset(h.getAttribute('data-pkc-fence-asset-info') ?? '', got.text, {
          currentContainerId: env.currentContainerId,
          allowExternalImages: env.allowExternalImages,
        });
        const next = holder.firstElementChild;
        if (next !== null) h.replaceWith(next);
      }),
    );
    if (stale()) return;
    // ② 本文に貼った画像(添付)── 同じ鍵は 1 回だけ借りる
    const byKey = new Map<string, HTMLImageElement[]>();
    for (const img of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]'))) {
      if (img.hasAttribute('src')) continue;
      const key = img.getAttribute('data-pkc-asset-key') ?? '';
      byKey.set(key, [...(byKey.get(key) ?? []), img]);
    }
    await Promise.all(
      [...byKey].map(async ([key, imgs]) => {
        let lent: { url: string; dispose: () => void } | null;
        try {
          lent = await this.deps.lend(key);
        } catch {
          lent = null;
        }
        if (lent === null) return;
        if (stale()) {
          lent.dispose();
          return;
        }
        o.disposers.push(lent.dispose);
        for (const img of imgs) img.src = lent.url;
      }),
    );
    if (stale()) return;
    // ③ 図(mermaid・グラフ・数式)── 本文の面と同じ 1 本
    const scopes = (this.deps.hydrateFigures ?? hydrateFigures)([host]);
    for (const s of scopes) o.disposers.push(() => s.dispose());
  }

  private release(o: OpenChapter): void {
    const ds = o.disposers.splice(0);
    for (const d of ds) {
      try {
        d();
      } catch {
        // 返せなくても、次を返す
      }
    }
  }

  private dispose(o: OpenChapter): void {
    o.gen++;
    this.release(o);
    if (o.pending !== null) {
      const clearT = this.deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      clearT(o.pending);
      o.pending = null;
    }
    this.windows.delete(o.name);
  }

  private ensurePoll(): void {
    if (this.poll !== null) return;
    const setI = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.poll = setI(() => this.tick(), POLL_MS);
  }

  private stopPoll(): void {
    if (this.poll === null) return;
    const clearI = this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clearI(this.poll);
    this.poll = null;
  }

  /**
   * 見張り 1 回。⚠ **閉じた窓は借りていた物を返して台帳から外す** / **F5 で白くなった窓は
   *   組み直す**。窓が 1 つも無くなったら見張りを止める(常駐させない)。
   */
  tick(): void {
    for (const o of [...this.windows.values()]) {
      let closed: boolean;
      try {
        closed = o.win.closed;
      } catch {
        closed = true;
      }
      if (closed) {
        this.dispose(o);
        continue;
      }
      if (!this.orphaned && !chapterWindowBuilt(o.win)) {
        // 🔑 白い窓に「待っている」を先に出す(組み直しは非同期)
        paintChapterWindow(o.win, {
          title: titleOf(this.deps.getState(), o.lid, o.ref.text),
          noteTitle: noteTitleOf(this.deps.getState(), o.lid),
          key: o.name,
          content: { kind: 'loading' },
        });
        void this.repaint(o);
      }
    }
    if (this.windows.size === 0) this.stopPoll();
  }
}

/**
 * 章の塊を取り出す(全文の描画結果から)。
 * ⚠ 組むのは**こちらの `document`**(`chapter-window.ts` の冒頭の実測)。
 * 🔑 脚注は章から参照されている物だけを、**元の番号のまま**末尾へ持って行く
 *   (脚注の定義は文書の末尾にまとまって出るので、章の範囲には入らない)。
 */
export function chapterBlocks(html: string, lines: ChapterLines): Node[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const box = document.createElement('div');
  box.append(tpl.content);
  const blocks: Node[] = blocksInRange(box, lines.from, lines.to);
  const refs = new Set<string>();
  for (const b of blocks) {
    if (!(b instanceof Element)) continue;
    for (const a of Array.from(b.querySelectorAll('sup.footnote-ref a[href^="#"]'))) {
      refs.add((a.getAttribute('href') ?? '').slice(1));
    }
  }
  const section = box.querySelector(':scope > section.footnotes');
  if (refs.size > 0 && section !== null) {
    const items = Array.from(section.querySelectorAll(':scope > ol > li'));
    items.forEach((li, i) => {
      if (!refs.has(li.id)) li.remove();
      else li.setAttribute('value', String(i + 1));
    });
    if (section.querySelector('li') !== null) {
      const sep = box.querySelector(':scope > hr.footnotes-sep');
      if (sep !== null) blocks.push(sep);
      blocks.push(section);
    }
  }
  return blocks;
}

/**
 * 組み直す合図。⚠ 変わったら組み直す物だけを並べる。
 * 🔑 本体でそのノートを**読む状態**で開いているなら、その本文も入れる(保存の ack より先に届く)。
 * ⚠ 全文編集の間は入れない(打ちかけを窓に映さない)。
 */
function signatureOf(state: AppState, lid: string): string {
  const meta = state.entryMetas.get(lid);
  if (meta === undefined) return '\u0000gone';
  return `${meta.updatedAt ?? ''}\u0000${meta.title}\u0000${readyBodyOf(state, lid) ?? ''}`;
}

/** 本体でそのノートを読む状態で開いていれば、その本文。 */
function readyBodyOf(state: AppState, lid: string): string | null {
  const ob = state.openBody;
  if (ob === null || ob.lid !== lid) return null;
  // ⚠ 全文編集で開いているのは `openBody` のノートだけ(アプリ全体で 1 つ)
  if (state.phase === 'editing') return null;
  return ob.body;
}

function noteTitleOf(state: AppState, lid: string): string {
  return state.entryMetas.get(lid)?.title ?? '';
}

/** 窓の題名(「ノート名 › 見出し」)。 */
function titleOf(state: AppState, lid: string, heading: string): string {
  const note = noteTitleOf(state, lid);
  return note === '' ? heading : `${note} › ${heading}`;
}

export { CHAPTER_WINDOW_TEXT };
