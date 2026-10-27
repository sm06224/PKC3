/**
 * 🔴 **PC のファイルとのつながりを、別のウィンドウへ渡す**(差分マージ・PC の別ウィンドウのレビュー ⚠4)。
 *
 * ## なぜ
 *
 * 「ノートとつながっている PC のファイル」の実体(ファイルハンドル)は、**開いた窓のメモリにだけ**ある
 * (`launched-files.ts`。どこにも保存しない ── 同意の延命をしない)。差分マージを別ウィンドウで開くと、その窓には
 * 1 つも無く、「PC のファイル」の相手が空になっていた。
 *
 * ## 決めたこと
 *
 * - 同じオリジンの窓どうしで、**同じコレクションを開いているとき**だけ渡す(`cid` が違えば答えない)。
 * - 渡すのは ハンドル(同じオリジンの `postMessage` / `BroadcastChannel` で複製できる)・ファイル名・取り込み時の更新時刻。
 *   **受けた窓も、元の窓も、どちらも読める**(読む許可は同じオリジンで共有される。足りなければ読み込みの失敗として言う)。
 * - 聞くのは**必要になったとき**(差分マージで「PC のファイル」を選ぶ・開く)── 起動のたびに放送しない。
 * - 複製できないブラウザでは、`post` が投げる。**黙って握りつぶさず `false` を返す**(画面は「本体のウィンドウの左の PC タブで…」と案内する)。
 * - 片道にしない: 別ウィンドウの PC で取り込んだつながりも、本体の窓が聞けば受け取れる(誰でも答える・誰でも聞ける)。
 *
 * ⚠ 判断だけをここに置く(放送の実体は差し替えられる ── test は本物の放送を持たずに通す)。
 */
import type { Broadcaster } from './storage/store-proxy';
import type { LaunchedHandle } from './launched-files';

export const LINKED_SHARE_CHANNEL = 'pkc3-linked-files';

/** 1 件のつながり。 */
export interface SharedLink {
  readonly lid: string;
  readonly name: string;
  readonly modifiedAt: number | null;
  readonly handle: LaunchedHandle;
}

type Wire =
  | { kind: 'linked-request'; cid: string; from: string }
  | { kind: 'linked-offer'; cid: string; to: string; items: readonly SharedLink[] };

export interface LinkedShareDeps {
  /** 放送を開く(`null` = 無い環境)。 */
  open(): Broadcaster | null;
  /** いまのコレクション id(読み込み前は `null`)。 */
  cid(): string | null;
  /** この窓が持っているつながり。 */
  list(): readonly SharedLink[];
  /** 受け取ったつながりを、この窓の記憶へ結ぶ(判断 ── 既に同じ lid が在るかなど ── は呼び側)。 */
  adopt(items: readonly SharedLink[]): void;
  /** この窓の名乗り(自分の放送を自分で拾わない)。 */
  newId(): string;
}

export class LinkedFileShare {
  private readonly deps: LinkedShareDeps;
  private readonly id: string;
  private ch: Broadcaster | null = null;

  constructor(deps: LinkedShareDeps) {
    this.deps = deps;
    this.id = deps.newId();
  }

  /** 答える側を始める。⚠ 何度呼んでも 1 本だけ開く。 */
  start(): void {
    if (this.ch !== null) return;
    const ch = this.deps.open();
    if (ch === null) return;
    this.ch = ch;
    ch.onmessage = (ev: MessageEvent) => this.onWire(ev.data as Wire);
  }

  /**
   * 他の窓に、つながりを渡してほしいと頼む。
   * @returns 頼めたか(放送が無い・複製できないときは `false`)
   */
  request(): boolean {
    this.start();
    const cid = this.deps.cid();
    if (this.ch === null || cid === null) return false;
    try {
      this.ch.postMessage({ kind: 'linked-request', cid, from: this.id } satisfies Wire);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.ch === null) return;
    this.ch.onmessage = null;
    this.ch.close();
    this.ch = null;
  }

  private onWire(w: Wire): void {
    if (w === null || typeof w !== 'object') return;
    const cid = this.deps.cid();
    if (cid === null) return;
    if (w.kind === 'linked-request') {
      if (w.from === this.id || w.cid !== cid) return;
      const items = this.deps.list();
      if (items.length === 0) return;
      try {
        this.ch?.postMessage({ kind: 'linked-offer', cid, to: w.from, items } satisfies Wire);
      } catch {
        /* 複製できないハンドル ── 渡せない(頼んだ側は、受け取れなかった案内を出す) */
      }
    } else if (w.kind === 'linked-offer') {
      if (w.to !== this.id || w.cid !== cid) return;
      if (!Array.isArray(w.items) || w.items.length === 0) return;
      this.deps.adopt(w.items);
    }
  }
}
