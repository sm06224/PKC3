/**
 * Office(LibreOffice wasm)の**別窓**を開く・使い回す・閉じる(#88 / 統合設計 O2)。
 *
 * 🔴 user 裁定 2026-08-10「**別タブでも構いません / 見やすければいいのだ /
 * 同じ窓にこだわると、PKC の編集をしながら資料を読むとかできませんし**」。
 *
 * ## 🔴 `noopener` で開く ── 趣味ではなく、**実測で決まった**
 *
 * O2 の受入条件「閉じたら 780MB が還るか」を測った結果(2026-08-11):
 *
 * | 開き方 | 増えた | 閉じた後に残った | **回収** |
 * |---|---|---|---|
 * | `open(url, 'pkc3-office')` | 608.9MB | 482.7MB | **21%** |
 * | `open(url, '_blank', 'noopener')` | 743.9MB | **5.8MB** | **99%** |
 *
 * ⚠ 待ちを 8 秒 → 25 秒に延ばしても 21% のまま ── **遅延解放ではない**。
 * 同一 origin の窓は**同じ browsing context group = 同じ renderer process**に入るので、
 * realm を捨てても process の heap が OS へ返らない。`noopener` は新しい context group を
 * 作るため、**閉じた瞬間に丸ごと還る**。
 *
 * ## 代償 ── handle も opener も失う。だから **BroadcastChannel** で話す
 *
 * `noopener` だと `window.open` は **null を返す**(開けたかどうかも分からない)。
 * したがってこの層は「窓を握る」のをやめ、**同一 origin の放送**でやり取りする:
 *
 * | 失うもの | 代わり |
 * |---|---|
 * | 文書の受け渡し / 保存の書き戻し | 放送 |
 * | 「もう開いているか」 | 窓からの**生存通知**(heartbeat) |
 * | 親から `close()` | 親が**頼み**、窓が自分で閉じる |
 * | 親から `focus()` | ⚠ **できないことがある**(背面タブの self-focus はブラウザ判断) |
 *
 * ⚠ できなかったときに**黙って何も起きない**ようにはしない ── `open()` は
 * 何が起きたかを戻り値で返し、呼び出し側が user へ言えるようにする。
 */

/** 放送の名前。⚠ 種別名は `pkc3Office` の 1 語に閉じる(id と紛れる名を作らない)。 */
export const OFFICE_CHANNEL = 'pkc3-office';

/** `host.html` の位置。⚠ 本体の hash 付き chunk 名に引きずられない固定 path。 */
export const OFFICE_HOST_PATH = 'office/host.html';

/** 窓が生きていると見なす猶予。heartbeat はこれより短い間隔で来る。 */
export const ALIVE_TTL_MS = 4000;

export type OfficeWindowEvent =
  /**
   * 生存通知。`visible` は**窓のタブがそのとき表に居たか**(#135)。
   *
   * 🔴 これが要るのは、**背面タブのタイマーが絞られる**から ── Chrome は
   * 5 分ほど背面に居たページの `setInterval` を **1 分に 1 回**まで落とす。
   * つまり「通知が 4 秒来ない = ハング」は**窓が表に居たときにしか言えない**。
   * ⚠ 窓が背面なら 60 秒空くのが正常なので、同じ物差しを当てると**必ず誤検知**する。
   * 判定は `office-hang-watch.ts` が持つ(ここは材料を運ぶだけ)。
   *
   * ⚠ 古い host は payload を持たない ── **その時は `false`**(= 絞られているかも
   * しれない側)に倒す。誤検知より見逃しを選ぶ。
   */
  | { readonly type: 'alive'; readonly visible: boolean }
  /**
   * 窓が**停止した**と言ってきた(`host.html` の `died()`)。
   *
   * ⚠ **生存通知は止まらない**(`host.html` の注記: 止めると本体が「閉じた」と
   * 判断して 2 つ目の窓を開く ── 1 窓 約 750MB)。だから停止はこれで別に伝わる。
   */
  | { readonly type: 'crashed'; readonly reason: string }
  /**
   * 版面は生きているが**命令が通らなくなった**(`host.html` の `degrade()`)。
   *
   * ⚠ **2026-08-16 まで、これは受け側で黙って捨てられていた** ── 窓は
   * `host.html` の `degrade()` から放送していたのに `parseEvent` に case が無く
   * `null` に落ちていた。**保存が効かなくなったことを user へ伝える唯一の信号**
   * なので、取りこぼすと「保存したのに残っていない」だけが残る。
   * ⚠ 他 file を**行番号で指さない**(この件の初稿は 146 行ずれていた)。
   */
  | { readonly type: 'degraded'; readonly reason: string }
  | { readonly type: 'ready-for-document' }
  | { readonly type: 'painted'; readonly ms: number }
  /**
   * 🔴 **保存された**(#205)。⚠ **bytes は載っていない ── 鍵だけ**である。
   *
   * bytes は窓が OPFS の棚(`office-stage.ts`)へ置いており、引き取るのは
   * **writer リースを持つタブだけ**(sqlite の `assets` 行を書けるのがそこだけなので)。
   * ⚠ 放送は全タブに届くので、鍵を見ただけで書きに行かないこと。
   */
  | { readonly type: 'saved'; readonly key: string; readonly name: string; readonly size: number }
  /**
   * 🔴 **保存を PKC へ渡せなかった**(OPFS が無い / 棚に書けない)。
   * ⚠ **黙って落とさない** ── user は保存したつもりでいる。
   */
  | { readonly type: 'save-failed'; readonly reason: string }
  | { readonly type: 'not-installed' }
  | { readonly type: 'unsupported'; readonly missing: readonly string[] }
  | { readonly type: 'closed' };

export interface OpenOptions {
  /** 窓に渡す表示名(そのまま file 名になる)。 */
  readonly name?: string;
  /** 開いた直後に流し込む文書。無ければ Start Center が出る。 */
  readonly bytes?: Uint8Array;
  /**
   * 文書は**後から** `provideDocument()` で渡す、と宣言する。
   *
   * 🔴 これが無いと**窓を 2 つ開く**。添付の bytes は IDB から読むので非同期だが、
   * `window.open` は user gesture の同期のうちに呼ばないと遮断される ──
   * つまり「開くのが先、bytes が後」になる。そこで
   * `open({ expectDocument: true })` → `provideDocument(...)` の 2 段にする。
   * ⚠ `open()` を 2 回呼んで解決しようとすると、1 回目の時点では生存通知が
   *   まだ届いていないので `isProbablyOpen()` が false になり、**2 つ目が開く**。
   */
  readonly expectDocument?: boolean;
}

export type OpenOutcome =
  /** 新しく開く指示を出した。⚠ 開けたかは生存通知で分かる(noopener は null を返す) */
  | { readonly kind: 'opened' }
  /** 既に開いていそうなので、開かずに放送で頼んだ。 */
  | { readonly kind: 'already-open' };

interface Broadcaster {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface OfficeWindowDeps {
  /** 差し替えられるのは test のため(本番は既定を使う)。 */
  readonly openWindow?: (url: string) => void;
  readonly makeChannel?: (name: string) => Broadcaster;
  readonly now?: () => number;
  readonly baseUrl?: string;
}

export class OfficeWindow {
  private readonly ch: Broadcaster;
  private readonly openWindow: (url: string) => void;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private lastAliveAt = 0;
  private pendingDoc: { name: string; bytes: Uint8Array; token: string } | null = null;
  /** 窓が先に「ちょうだい」と言ってきたが、まだ bytes が無い状態。 */
  private askedForDoc = false;
  private readonly listeners = new Set<(ev: OfficeWindowEvent) => void>();

  constructor(deps: OfficeWindowDeps = {}) {
    this.openWindow = deps.openWindow
      // 🔴 **`noopener` を外さない。** 外すと回収が 99% → 21% に落ちる(上の表)
      ?? ((url) => { window.open(url, '_blank', 'noopener'); });
    this.now = deps.now ?? ((): number => Date.now());
    this.baseUrl = deps.baseUrl ?? document.baseURI;
    this.ch = deps.makeChannel
      ? deps.makeChannel(OFFICE_CHANNEL)
      : (new BroadcastChannel(OFFICE_CHANNEL) as unknown as Broadcaster);
    this.ch.onmessage = (ev: MessageEvent): void => { this.receive(ev.data); };
  }

  onEvent(fn: (ev: OfficeWindowEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * 直近の生存通知から見て、窓が開いていそうか。
   * ⚠ **断定はできない**(放送は片道)。これを根拠に user へ言い切らない。
   */
  isProbablyOpen(): boolean {
    return this.now() - this.lastAliveAt < ALIVE_TTL_MS;
  }

  /**
   * 開く(開いていそうなら開かずに放送で頼む)。
   *
   * ⚠ **click ハンドラの同期の中から呼ぶこと。** `await` を挟むと user gesture が
   * 切れてポップアップ遮断に遭う ── 文書は**窓が準備できてから**放送で渡す作り。
   */
  open(opts: OpenOptions = {}): OpenOutcome {
    this.pendingDoc = opts.bytes
      ? { name: opts.name ?? 'document', bytes: opts.bytes, token: '' }
      : null;
    // ⚠ 新しく開く / 読み直させるので、前の「ちょうだい」は無効にする
    this.askedForDoc = false;
    const wantsDoc = opts.bytes !== undefined || opts.expectDocument === true;

    if (this.isProbablyOpen()) {
      // ⚠ 2 つ立てると常駐が倍になる(1 窓 約 750MB 実測)。開かずに頼む
      this.ch.postMessage({ pkc3Office: 'focus-request', payload: {} });
      if (wantsDoc) {
        this.ch.postMessage({
          pkc3Office: 'reload-request',
          payload: { name: opts.name ?? '', awaitDoc: true },
        });
      }
      return { kind: 'already-open' };
    }

    this.openWindow(this.hostUrl(opts));
    return { kind: 'opened' };
  }

  /**
   * 後から文書を渡す(`open({ expectDocument: true })` と対で使う)。
   *
   * ⚠ 窓が既に「ちょうだい」と言っていたら**その場で**送る。まだなら控えておき、
   * 言ってきた時に送る ── どちらの順序でも落とさない。
   *
   * @param token 🔴 **どのノートの添付か**を表す合言葉(#205)。窓がそのまま
   *   保存に載せて返す ── ⚠ **こちらの記憶に頼らない**(窓は `noopener` で handle が
   *   無く、PKC のタブを読み直すと対応表が消えるが、窓は別 process で生き残る)。
   *   ⚠ 省くと、その窓の保存は**新しい添付ノート**になる。
   */
  provideDocument(name: string, bytes: Uint8Array, token = ''): void {
    // ⚠ 空を渡して Start Center を上書きしない
    if (bytes.byteLength === 0) return;
    this.pendingDoc = { name, bytes, token };
    if (this.askedForDoc) this.sendDocument();
  }

  /** 閉じてくれと頼む。⚠ 握っていないので、こちらから強制はできない。 */
  requestClose(): void {
    this.ch.postMessage({ pkc3Office: 'close-request', payload: {} });
  }

  dispose(): void {
    this.listeners.clear();
    this.ch.onmessage = null;
    this.ch.close();
  }

  /**
   * 窓の URL を組む。
   *
   * ⚠ **`URLSearchParams` を使わない。** `tests/features/flags.test.ts` の全数検査は
   * その綴りを「クエリを読んでいる」と見なす ── **ガードは正しい**ので、綴りを
   * 例外にするのではなく**要らない API を使わない**形にする。
   */
  private hostUrl(opts: OpenOptions): string {
    const q: string[] = [];
    if (opts.name) q.push(`name=${encodeURIComponent(opts.name)}`);
    // ⚠ 窓側は `await-doc` が在るときだけ文書を待つ。無いと無駄に待つ
    if (opts.bytes !== undefined || opts.expectDocument === true) q.push('await-doc=1');
    const base = new URL(OFFICE_HOST_PATH, this.baseUrl).href;
    return q.length > 0 ? `${base}?${q.join('&')}` : base;
  }

  private receive(data: unknown): void {
    const ev = parseEvent(data);
    if (!ev) return;
    if (ev.type === 'alive') this.lastAliveAt = this.now();
    if (ev.type === 'closed') this.lastAliveAt = 0;
    if (ev.type === 'ready-for-document') {
      // ⚠ **bytes がまだ無いこともある**(添付を IDB から読んでいる最中)。
      //    その時は覚えておき、届いたら送る ── 取りこぼすと窓が 15 秒待って諦める
      this.askedForDoc = true;
      this.sendDocument();
    }
    for (const fn of this.listeners) fn(ev);
  }

  private sendDocument(): void {
    const doc = this.pendingDoc;
    if (!doc) return;
    this.pendingDoc = null;
    this.askedForDoc = false;
    // ⚠ BroadcastChannel は **transfer できない**(structured clone のみ)ので、
    //    ここだけはコピーになる。大きい文書で効くなら IDB 経由の受け渡しへ替える。
    this.ch.postMessage({
      pkc3Office: 'document',
      payload: { name: doc.name, bytes: doc.bytes, token: doc.token },
    });
  }
}

function parseEvent(data: unknown): OfficeWindowEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { pkc3Office?: unknown; payload?: unknown };
  const p = (d.payload ?? {}) as {
    ms?: unknown; missing?: unknown; name?: unknown; key?: unknown; size?: unknown;
    visible?: unknown; reason?: unknown;
  };
  switch (d.pkc3Office) {
    case 'alive':
      // ⚠ 古い host は `visible` を送らない ── 既定は false(絞られている側)
      return { type: 'alive', visible: p.visible === true };
    case 'crashed':
      return { type: 'crashed', reason: typeof p.reason === 'string' ? p.reason : '' };
    case 'degraded':
      return { type: 'degraded', reason: typeof p.reason === 'string' ? p.reason : '' };
    case 'ready-for-document':
      return { type: 'ready-for-document' };
    case 'painted':
      return { type: 'painted', ms: typeof p.ms === 'number' ? p.ms : 0 };
    case 'not-installed':
      return { type: 'not-installed' };
    case 'closed':
      return { type: 'closed' };
    case 'unsupported':
      return { type: 'unsupported', missing: Array.isArray(p.missing) ? p.missing.map(String) : [] };
    case 'saved':
      // ⚠ **鍵と大きさを検めてから通す。** 空の保存で添付を上書きしない ──
      //    ⚠ 2026-08-16 まで `bytes` を見ていたが、bytes は載らなくなった(棚に置く)
      if (typeof p.key !== 'string' || p.key === '') return null;
      if (typeof p.size !== 'number' || !(p.size > 0)) return null;
      return {
        type: 'saved',
        key: p.key,
        name: typeof p.name === 'string' && p.name !== '' ? p.name : 'document',
        size: p.size,
      };
    case 'save-failed':
      return { type: 'save-failed', reason: typeof p.reason === 'string' ? p.reason : '' };
    default:
      return null;
  }
}
