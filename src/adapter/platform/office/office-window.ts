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

/**
 * 🔴 **「このノートになった」を返す放送の種別**(#217)。
 *
 * ⚠ **`public/office/host.html` と同じ綴りでなければ機構ごと死ぬ**。しかも
 * 両側とも自分の literal を test で pin しているだけなので、**一貫して改名すると
 * unit も smoke も緑のまま本番だけ壊れる**(着地前レビューで実際に構成された)。
 * 🔑 だから定数にして、`tests/adapter/office-window.test.ts` が
 * **`host.html` の原文と突合する**(`OFFICE_STAGE_DIR` と同じ形)。
 */
export const OFFICE_ADOPTED = 'adopted';

/**
 * 🔴 **窓が「やめる」を選んだときに本体の状態の行へ出す一言**(#1228 穴②)。
 * ⚠ 本体は文書を渡す前に「開いている Office のウィンドウに表示します」と言っているので、
 * これは**その取り消し**である ── user には「押したのに何も起きない」ではなく理由が見える。
 * 🔑 窓の中の確認の字(「保存していない変更があります。…」)は `public/office/host.html` に在り、
 * `tests/adapter/office-window.test.ts` が原文で突き合わせる。
 */
export const OFFICE_DECLINED_NOTICE =
  'Office のウィンドウに保存していない変更があるため開きませんでした';

/** 窓が生きていると見なす猶予。heartbeat はこれより短い間隔で来る。 */
export const ALIVE_TTL_MS = 4000;
/**
 * 🔴 **窓が「閉じた」と言ってから、送った文書を覚えておく間**(#1228 穴①)。
 *
 * ⚠ 「読み込み直す」(`location.reload()`)でも窓は `pagehide` → `closed` を放送する ──
 * **閉じたのか読み直しなのかは、この通知だけでは区別できない**。読み直しなら数秒のうちに
 * 作り直した窓が `ready-for-document` で戻ってくるので、その間だけ捨てずに待つ。
 * 戻って来なければ本当に閉じたので、ここで bytes を手放す(heap に抱え続けない)。
 */
export const RESEND_GRACE_MS = 30_000;

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
  /**
   * 🔴 **窓が別の文書へ替えるのをやめた**(#1228 穴②)。窓の中に**保存していない変更**があり、
   * user が確認で「やめる」を選んだ。⚠ 未保存かどうかを見るのは**窓の中の 1 か所**(`host.html`)で、
   * 本体はこの結果だけを受ける(本体は LO の中を知らない)。
   * 受けたとき、`OfficeWindow` は渡すつもりだった文書を手放し、元の文書の控えを戻す。
   */
  | { readonly type: 'reload-declined' }
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

/**
 * 「挿入 → 画像」に並べる添付 1 件(#146)。⚠ 文書と**同じ封筒**に載せる ── 経路を増やさない。
 * `name` は**元の file 名**、`bytes` はそのまま窓の FS へ書かれる。
 */
export interface OfficeImagePayload {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 窓へ渡す文書の中身(bytes と、並べる画像)。 */
export interface OfficeDocumentSource {
  readonly bytes: Uint8Array;
  readonly images?: readonly OfficeImagePayload[];
}

/**
 * 🔴 **いまの文書を読み直す口**(#1228 穴①)。窓が作り直されて文書を再び求めたときに呼ぶ。
 *
 * ⚠ 窓の中で保存すると添付は**別の key に差し替わる**ので、最初に渡した bytes は古い。
 * 呼び側が「そのノートの**いま**の添付」を引ける口を渡せば、読み直した窓は
 * 保存済みの最新を開く(古い版を開いて編集し、保存で新しい版を上書きする、を作らない)。
 * `null` は「もう読めない」(ノートが消えた等)── このときは何も送らない。
 */
export type OfficeDocumentRefresh = () => Promise<OfficeDocumentSource | null>;

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

/** 窓へ送った文書の控え(送り直し用)。⚠ `bytes` は `refresh` が無いときだけ持つ。 */
interface SentDocument {
  name: string;
  token: string;
  bytes: Uint8Array | null;
  images: readonly OfficeImagePayload[];
  refresh: OfficeDocumentRefresh | null;
}

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
  /**
   * 🔴 **入力の経路を console に出すか**(#433 の計測。flag `office.inputLog`)。
   * ⚠ **関数で渡す** ── flag はフラグ画面から変わるので、値で渡すと
   *   「切り替えたのに次の窓でも出ない」になる。
   */
  readonly inputLog?: () => boolean;
}

export class OfficeWindow {
  private readonly ch: Broadcaster;
  private readonly openWindow: (url: string) => void;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly inputLog: () => boolean;
  private lastAliveAt = 0;
  private pendingDoc: {
    name: string;
    bytes: Uint8Array;
    token: string;
    images: readonly OfficeImagePayload[];
    refresh: OfficeDocumentRefresh | null;
  } | null = null;
  /**
   * 🔴 **最後に窓へ送った文書の控え**(#1228 穴①)。窓が**作り直されて**もう一度
   * `ready-for-document` と言ってきたとき(停止の帯の「読み込み直す」)に送り直すために要る ──
   * 無いと、読み直した窓は 15 秒待って Start Center になる。
   * ⚠ `refresh` を持つ文書は **bytes / images を抱えない**(読み直すときに引く)。
   * ⚠ 窓が閉じて `RESEND_GRACE_MS` 戻らなければ捨てる / 新しい文書を頼む `open()` でも捨てる。
   */
  private lastSent: SentDocument | null = null;
  /**
   * 🔴 **別の文書を頼んだときに、取り除いておいた元の文書の控え**(#1228 穴②)。
   * 窓は確認で「やめる」を選びうる ── そのとき元の文書(窓に出たまま)の控えが無いと、
   * 後で窓が作り直されたとき(停止の帯の「読み込み直す」)に**文書を送り直せない**。
   * ⚠ 窓が「開く」を選べば `sendDocument` が新しい控えで置き換えるので、ここは手放す。
   */
  private heldSent: SentDocument | null = null;
  /**
   * `open({ expectDocument })` で宣言した文書が、まだ `provideDocument` に届いていない間。
   * ⚠ 「やめた」がその**前に**届いたとき、後から来る文書を**受け取らず捨てる**ために要る
   * (添付の bytes は非同期に読むので、確認の答えのほうが先に着くことがある)。
   */
  private awaitingProvide = false;
  private discardNextProvide = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
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
    // ⚠ **関数で受ける**(値で受けない)── flag はフラグ画面から変わりうるので、
    //   構築時に固めると「切り替えたのに次の窓でも出ない」になる
    this.inputLog = deps.inputLog ?? ((): boolean => false);
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
      ? { name: opts.name ?? 'document', bytes: opts.bytes, token: '', images: [], refresh: null }
      : null;
    // ⚠ 新しく開く / 読み直させるので、前の「ちょうだい」は無効にする
    this.askedForDoc = false;
    const wantsDoc = opts.bytes !== undefined || opts.expectDocument === true;
    // 🔴 「やめた」が来る前の文書は受け取らない、の印は新しい依頼ごとに引き直す(#1228 穴②)
    this.discardNextProvide = false;
    this.awaitingProvide = opts.bytes === undefined && opts.expectDocument === true;
    // 🔴 別の文書が来る(or 窓を新しく作る)ので、前の文書の控えは**送り直しの対象から外す**。⚠ 残すと
    //    「次の文書がまだ届いていない間に窓が ready と言った」とき**前の文書を送る**。
    //    ⚠ 生きている窓へ `open({})`(Start Center だけ)と頼むときは窓の中身が変わらないので残す
    if (wantsDoc || !this.isProbablyOpen()) {
      // 🔑 ただし**生きている窓へ別の文書を頼む**ときは、窓が確認で「やめる」を選びうる(#1228 穴②)
      //    ── 窓には元の文書が出たままなので、控えは取っておく(2 件続けて頼んでも元の 1 件を保つ)
      const keep = wantsDoc && this.isProbablyOpen() ? (this.lastSent ?? this.heldSent) : null;
      this.dropLastSent();
      this.heldSent = keep;
    }

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
   * @param images 🔴 **「挿入 → 画像」に並べる添付**(#146)。窓が文書を書く**同じ口**で
   *   `/home/web_user` へ置く。⚠ 空なら封筒に `images` を**載せない**(今までと 1 バイトも変わらない)
   */
  provideDocument(
    name: string,
    bytes: Uint8Array,
    token = '',
    images: readonly OfficeImagePayload[] = [],
    refresh: OfficeDocumentRefresh | null = null,
  ): void {
    // ⚠ 空を渡して Start Center を上書きしない
    if (bytes.byteLength === 0) return;
    this.awaitingProvide = false;
    // 🔴 窓が「やめた」と言った**後**に届いた文書は受け取らない(窓はもう替わらない)
    if (this.discardNextProvide) {
      this.discardNextProvide = false;
      return;
    }
    this.pendingDoc = { name, bytes, token, images, refresh };
    if (this.askedForDoc) this.sendDocument();
  }

  /**
   * 🔴 **「この保存はこのノートになった」と窓へ返す**(#217)。
   *
   * ⚠ これが無いと、**同じ文書を 2 回保存するとノートが 2 件できる** ──
   * 窓が知っている合言葉は「PKC から渡した添付」の分だけで、
   * **窓の中で新規に作った文書**(Start Center → 別名で保存)には最初から無い。
   * 1 回目で作ったノートを窓へ教えないと、2 回目も「合言葉の無い保存」として
   * また新規のノートになる(cowork 実機 2026-08-16 で 1/1 再現)。
   *
   * 🔑 **path ではなく棚の鍵で指す。** 窓は `handOff` した鍵 → path を覚えているので、
   * 鍵で返せば**どの保存の話か**が一意に決まる ── ⚠ path で返すと、
   * 別の窓が同じ名前の文書を開いているとき**取り違える**(`/work/報告.odt` は
   * 窓ごとに別の MEMFS に在り、放送は全窓に届く)。
   */
  adoptSave(key: string, token: string): void {
    if (key === '' || token === '') return;
    // ⚠ **投げさせない。** ここが投げると、呼び元(`office-save-back.ts`)が棚を
    //    消す前に抜け、次の掃除で**もう 1 件ノートができる** ── 直したい症状の逆向き。
    //    🔑 窓側の `say()` も同じ形で包んである(閉じたチャネルは投げる)
    try {
      this.ch.postMessage({ pkc3Office: OFFICE_ADOPTED, payload: { key, token } });
    } catch {
      // 閉じている ── 返せないだけで、取り込みは成功している
    }
  }

  /** 閉じてくれと頼む。⚠ 握っていないので、こちらから強制はできない。 */
  requestClose(): void {
    this.ch.postMessage({ pkc3Office: 'close-request', payload: {} });
  }

  dispose(): void {
    this.dropLastSent();
    this.heldSent = null;
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
    /**
     * 🔴 **#433 の計測**(flag `office.inputLog`)── 窓側が `preRun` で
     * `QT_LOGGING_RULES` を立てる。⚠ 既定では 1 文字も足さない。
     *
     * 🔑 **判定はここ 1 か所**(§7)── 窓を開く口は 2 つある
     * (添付から開く / Start Center を開く)ので、呼び手ごとに渡す形にすると
     * **片方だけ log が出ない**という、いちばん読み違えやすい形になる。
     */
    if (this.inputLog()) q.push('input-log=1');
    const base = new URL(OFFICE_HOST_PATH, this.baseUrl).href;
    return q.length > 0 ? `${base}?${q.join('&')}` : base;
  }

  private receive(data: unknown): void {
    const ev = parseEvent(data);
    if (!ev) return;
    if (ev.type === 'alive') this.lastAliveAt = this.now();
    if (ev.type === 'closed') {
      this.lastAliveAt = 0;
      // ⚠ 読み直しでも `closed` は来る(上の `RESEND_GRACE_MS`)── すぐには捨てず、戻らなければ捨てる
      this.armGrace();
    }
    if (ev.type === 'reload-declined') this.onDeclined();
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
    if (!doc) {
      // 🔴 **作り直された窓がもう一度求めてきた**(#1228 穴①)── 最後に送った文書を送り直す。
      //    ⚠ 「1 回目」と区別するのは `pendingDoc` の有無だけ ── 1 回目は送った時点で空になるので、
      //    同じ求めに 2 通は送らない
      this.resendLast();
      return;
    }
    this.pendingDoc = null;
    this.askedForDoc = false;
    // 🔑 窓が替わって新しい文書を求めた ── 元の文書の控えはもう要らない(新しい控えで置き換わる)
    this.heldSent = null;
    // ⚠ 窓が戻ってきた ── 閉じる猶予は解く(次に閉じたとき、また掛ける)
    this.clearGrace();
    // ⚠ 控えは `refresh` が無いときだけ bytes を持つ(在るなら読み直すので抱えない)
    this.lastSent = {
      name: doc.name,
      token: doc.token,
      bytes: doc.refresh ? null : doc.bytes,
      images: doc.refresh ? [] : doc.images,
      refresh: doc.refresh,
    };
    this.post(doc.name, doc.bytes, doc.token, doc.images);
  }

  private resendLast(): void {
    const last = this.lastSent;
    if (!last) return;
    this.askedForDoc = false;
    this.clearGrace();
    if (last.refresh) {
      // ⚠ 窓の中で保存済みなら本体の添付は差し替わっている ── **いまの**添付を引き直して送る
      void last.refresh().then(
        (src) => {
          // 待つ間に別の文書へ替わった / 閉じた なら送らない(古い文書を出さない)
          if (this.lastSent !== last || src === null || src.bytes.byteLength === 0) return;
          this.post(last.name, src.bytes, last.token, src.images ?? []);
        },
        () => { /* 読めなかった ── 窓は 15 秒で Start Center になる */ },
      );
      return;
    }
    if (last.bytes) this.post(last.name, last.bytes, last.token, last.images);
  }

  /**
   * 🔴 **窓が「替えない」と言った**(#1228 穴②)。窓には元の文書が出たままである。
   * - 渡すつもりだった文書(まだ送っていない分)は手放す
   * - まだ `provideDocument` に届いていないなら、届いたとき受け取らない
   * - 取り除いておいた元の文書の控えを戻す(あとで窓が作り直されても元の文書を送り直せる)
   */
  private onDeclined(): void {
    this.pendingDoc = null;
    this.askedForDoc = false;
    if (this.awaitingProvide) this.discardNextProvide = true;
    this.awaitingProvide = false;
    if (this.heldSent) {
      this.lastSent = this.heldSent;
      this.heldSent = null;
    }
  }

  /** 文書の封筒を組む口(**ここ 1 か所** ── §7)。 */
  private post(
    name: string,
    bytes: Uint8Array,
    token: string,
    images: readonly OfficeImagePayload[],
  ): void {
    // ⚠ BroadcastChannel は **transfer できない**(structured clone のみ)ので、
    //    ここだけはコピーになる。大きい文書で効くなら IDB 経由の受け渡しへ替える。
    //    🔴 画像(`images`)も**同じ封筒**なのでコピーになる ── 合計は
    //    `OFFICE_IMAGE_BUDGET_BYTES`(64 MB)で止めてある。⚠ 送った後の控え(`pendingDoc`)は
    //    すぐ手放す(受け取った窓の FS に載るのが唯一の常駐)。
    this.ch.postMessage({
      pkc3Office: 'document',
      payload: {
        name,
        bytes,
        token,
        // ⚠ 0 件なら載せない(封筒を組むのはここ 1 か所 ── §7)
        ...(images.length > 0 ? { images } : {}),
      },
    });
  }

  private armGrace(): void {
    this.clearGrace();
    if (!this.lastSent && !this.heldSent) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.lastSent = null;
      this.heldSent = null;
    }, RESEND_GRACE_MS);
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private dropLastSent(): void {
    this.clearGrace();
    this.lastSent = null;
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
    case 'reload-declined':
      return { type: 'reload-declined' };
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
