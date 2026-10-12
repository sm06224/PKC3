/**
 * PDF を **PKC の画面で読む別窓**の、本体側(#275 段①。裁定: 設定で選んだ人だけ)。
 *
 * 窓の中身は `public/pdf/`(素の HTML + JS + pdf.js)。ここは**開く・文書を渡す・窓からの合図を受ける**
 * だけで、頁を描くことも、ノートへ書くことも**しない**(書く判断は `main.ts` が持つ)。
 *
 * ## 🔴 作りの要点(Office の窓 `office/office-window.ts` と同じ向き)
 *
 * - **`noopener` で開く** ── 閉じた瞬間に process ごと還る(Office で実測 99%)。代償は handle も
 *   opener も失うこと。だから**同一 origin の放送**で話す(窓が自分で `hello` と言ってくる)。
 * - **bytes は放送に載せない。** 載せるのは**貸した ObjectURL の字だけ**で、窓が `fetch` で Blob を
 *   取る(ゼロコピー)。窓が受け取った合図(`loaded`)で**すぐ返す** ── 窓の寿命まで握り続けない
 *   (不可侵指示 2026-07-27「生成物は寿命の終端で破棄」。終端は「窓が Blob を握った瞬間」)。
 * - **開けたかは `hello` で分かる。** `noopener` は null を返すので、一定時間 `hello` が来なければ
 *   「窓が開かなかった」と読み、貸した URL をその場で捨てる(押した数だけ blob が積もらない)。
 * - **放送は全タブに届く。** 合図の `token` は**自分が開いた窓のもの**だけ受ける(他のタブの窓へ
 *   書き込まない)── Office の `saved` を writer リースを持つタブだけが引き取るのと同じ理由。
 *
 * ## 封筒(窓 ⇄ 本体)
 *
 * 全部 `{ pkc3Pdf: <種別>, token, payload }`。⚠ 窓側の綴りは `public/pdf/reader-wire.js`。
 * `tests/adapter/pdf-window.test.ts` が**実物どうし**を繋いで突き合わせる(片方だけ改名すると
 * 機構ごと死ぬ ── 両側が自分の literal を pin しているだけでは、一貫した改名で緑のまま壊れる)。
 */
import { PDF_QUOTE_MAX_BYTES, PDF_QUOTE_TOO_LONG, utf8Length } from '@features/pdf/pdf-quote';

/** 放送の名前。⚠ 窓側(`public/pdf/reader-wire.js`)と同じ綴り。 */
export const PDF_CHANNEL = 'pkc3-pdf';
/** 封筒の種別を載せる鍵。⚠ id と紛れる名を作らない。 */
export const PDF_TAG = 'pkc3Pdf';
/** 窓の位置。⚠ 本体の hash 付き chunk 名に引きずられない固定 path。 */
export const PDF_HOST_PATH = 'pdf/host.html';

/** `hello` がこれより遅れたら「窓が開かなかった」と読む。 */
export const HELLO_TIMEOUT_MS = 5000;
/** 窓が生きていると見なす猶予。⚠ 窓の heartbeat(3 秒)より長い。 */
export const ALIVE_TTL_MS = 8000;

/** 窓へ開き方を渡す大きさ。⚠ 頁を読むので大きく開く(添付の窓と同じ)。 */
const WINDOW_FEATURES = 'popup,noopener,width=1000,height=860';

/** 本体が窓へ渡す物。 */
export interface PdfLent {
  /** ObjectURL。⚠ 窓が `loaded` / `fell-back` / `load-failed` と言うか、`closed` で**捨てる**。 */
  readonly url: string;
  readonly dispose: () => void;
}

/** 開いた窓 1 枚の控え。 */
export interface PdfSession {
  readonly token: string;
  readonly assetKey: string;
  readonly name: string;
  /** 添付ノートの lid(引く先を解く起点)。無い呼び口なら `null`。 */
  readonly lid: string | null;
}

/** 「引く」の結果。窓へそのまま返る(窓が自分の画面へ出す)。 */
export interface PdfQuoteResult {
  readonly ok: boolean;
  /** 窓に出す一言。⚠ user の言葉で(内部語を出さない)。 */
  readonly message: string;
}

/**
 * 「編集した PDF を保存する」の結果(#275 段②-1b)。窓へそのまま返る(窓が自分の画面へ出す)。
 * ⚠ 形は `PdfQuoteResult` と同じ ── 窓の「返事を待つ」作法も同じ(`reader-wire.js` の `EDIT_TIMEOUT_MS`)。
 */
export interface PdfEditResult {
  readonly ok: boolean;
  /** 窓に出す一言。⚠ user の言葉で(内部語を出さない)。 */
  readonly message: string;
}

/**
 * 窓の「PDF を足す → 添付から選ぶ」に出す、この collection の PDF の添付 1 件(#275)。
 * ⚠ 窓へ渡すのは**題名と大きさと鍵だけ**(bytes は `attach-get` で貸した URL から取る)。
 */
export interface PdfAttachmentItem {
  /** 添付の鍵(`attach-get` で bytes を借りるとき、そのまま返ってくる)。 */
  readonly key: string;
  readonly name: string;
  readonly size: number | null;
}

/** 窓が借りた添付の URL を、窓が `attach-got` と言わないまま放っておいたときに返すまでの時間。 */
export const ATTACH_LEND_TTL_MS = 30000;
/** 窓へ渡す一覧の件数の上限(放送の大きさの歯止め)。 */
export const ATTACH_LIST_MAX = 500;
/** `attach-get` の鍵として受ける長さの上限。 */
const ATTACH_KEY_MAX = 256;

interface Broadcaster {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface PdfReaderDeps {
  /**
   * 引く(本体のノートへ書く)。⚠ 判断も書き込みも呼び側(`main.ts`)が持つ。
   * 🔴 **Promise** ── 「引けた」は disk に着いてから言う(錠を掛けた時点で返さない)。
   */
  readonly onQuote: (session: PdfSession, text: string, page: number) => Promise<PdfQuoteResult>;
  /**
   * 🔴 **窓が、編集した PDF を棚へ置いた**(`key` = 棚の中の置き物の鍵。#275 段②-1b)。
   * ⚠ bytes は放送に載らない(窓が OPFS の棚へ置き、本体が棚から読む ── Office の窓の保存と同じ鎖)。
   * 🔴 **Promise** ── 「できた」は新しい添付が作れてから返す。失敗しても理由を返す(窓を待たせ続けない)。
   */
  readonly onEdited: (session: PdfSession, key: string) => Promise<PdfEditResult>;
  /**
   * 🔴 **窓が「添付から選ぶ」を開いた**(#275 結合)。この collection の PDF の添付の一覧を返す。
   * ⚠ 一覧に載せるかの判断(PDF か・自分自身を含めるか)は呼び側(`main.ts` → `features/pdf/pdf-attachments.ts`)が持つ。
   */
  readonly listAttachments: () => Promise<readonly PdfAttachmentItem[]>;
  /**
   * 🔴 **窓が、選んだ添付の bytes を借りたい**。貸せるのは**一覧にある PDF の添付だけ**(呼び側が最後の門 ── 窓の鍵を信用しない)。
   * 無ければ `null`。⚠ 貸した URL は窓が `attach-got` と言うか、`ATTACH_LEND_TTL_MS` 経つか、窓が閉じたときに本体が返す。
   */
  readonly lendAttachment: (key: string) => Promise<PdfLent | null>;
  /** 窓が読めず、内蔵の表示へ退避した(断り文は出さない。状態の行へ 1 行)。 */
  readonly onFellBack: (session: PdfSession) => void;
  /** 窓が文書を取れなかった(貸した URL が既に無い等)。 */
  readonly onLoadFailed: (session: PdfSession, reason: string) => void;
  /** 窓が `HELLO_TIMEOUT_MS` のうちに現れなかった(ポップアップが止められた等)。 */
  readonly onOpenFailed: (session: PdfSession) => void;
  /**
   * 🔴 **名乗りが遅れて届いた**(`HELLO_TIMEOUT_MS` で「開かなかった」と読んで捨てた token から)。
   * ⚠ `noopener` では「止められた」と「遅いだけ」を区別できないので、先の断り
   * (`onOpenFailed`)は**誤った理由**だったことになる ── 呼び側が言い直す。
   * ⚠ 貸した URL は捨てた後なので、窓へは渡せない(窓は自分で「もう一度」と言う)。
   */
  readonly onLateHello: (session: PdfSession) => void;
  readonly makeChannel?: (name: string) => Broadcaster;
  /** 窓を開く(既定 `window.open`)。⚠ `noopener` は features に入っている。 */
  readonly openWindow?: (url: string, features: string) => void;
  readonly baseUrl?: string;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
  readonly newToken?: () => string;
}

/** 捨てた token の控えの数(新しい順に残す)。⚠ 窓の F5 / 遅い名乗りだけが引く ── 数は小さくてよい。 */
const GONE_KEEP = 16;

interface Gone {
  readonly session: PdfSession;
  /** 「開かなかった」と読んで捨てた回(まだ言い直していない)なら `true`。 */
  openFailed: boolean;
}

interface Live {
  readonly session: PdfSession;
  readonly lent: PdfLent;
  lentDisposed: boolean;
  lastAliveAt: number;
  helloTimer: unknown;
  /** 窓へ貸している添付の URL(`attach-get`)。鍵 → 貸し出しと、返す時計。 */
  readonly attachLends: Map<string, { lent: PdfLent; timer: unknown }>;
}

export class PdfReaderHost {
  private readonly ch: Broadcaster;
  private readonly lives = new Map<string, Live>();
  /** 捨てた(時間切れ / 閉じた)token の控え。⚠ 窓が名乗り直したとき、黙らず答えるために引く。 */
  private readonly gone = new Map<string, Gone>();
  /** 貸している最中の添付(`lend` の await の間に 2 回目の押しが 2 枚目を開かないための印)。 */
  private readonly lending = new Set<string>();
  private readonly openWindow: (url: string, features: string) => void;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly newToken: () => string;
  private seq = 0;

  constructor(private readonly deps: PdfReaderDeps) {
    this.ch = deps.makeChannel
      ? deps.makeChannel(PDF_CHANNEL)
      : (new BroadcastChannel(PDF_CHANNEL) as unknown as Broadcaster);
    this.ch.onmessage = (ev: MessageEvent): void => {
      this.receive(ev.data);
    };
    this.openWindow =
      deps.openWindow ??
      ((url, features): void => {
        // 🔴 `noopener` を外さない(閉じたとき process ごと還る ── 上の注記)
        window.open(url, '_blank', features);
      });
    this.baseUrl = deps.baseUrl ?? document.baseURI;
    this.now = deps.now ?? ((): number => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h): void => clearTimeout(h as number));
    this.newToken =
      deps.newToken ??
      ((): string => {
        this.seq += 1;
        const rnd =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().replace(/-/g, '')
            : `${this.now().toString(36)}${String(this.seq)}`;
        return `p${rnd}`;
      });
  }

  /** この添付の窓が**いま開いていそう**か(⚠ 断定はできない ── 放送は片道)。 */
  openTokenFor(assetKey: string): string | null {
    for (const l of this.lives.values()) {
      if (l.session.assetKey === assetKey && this.now() - l.lastAliveAt < ALIVE_TTL_MS) {
        return l.session.token;
      }
    }
    return null;
  }

  /**
   * 貸し始める印を付ける。@returns 付けられたら `true` / 既に貸している最中なら `false`
   * (呼び側は「もう開いています」で断る)。⚠ 付けたら**必ず** `unmarkLending` する。
   */
  markLending(assetKey: string): boolean {
    if (this.lending.has(assetKey)) return false;
    this.lending.add(assetKey);
    return true;
  }

  unmarkLending(assetKey: string): void {
    this.lending.delete(assetKey);
  }

  /** 開いている窓へ「前に出して」と頼む(⚠ ブラウザが断ることがある)。 */
  focus(token: string): void {
    this.send('focus-request', token, {});
  }

  /**
   * 窓を開く。⚠ 呼び側は**貸してから**呼ぶ ── 開けなかったとき(`hello` が来ない)は
   * ここが `lent.dispose()` まで持つ。
   */
  open(args: { assetKey: string; name: string; lid: string | null; lent: PdfLent }): PdfSession {
    const token = this.newToken();
    const session: PdfSession = {
      token,
      assetKey: args.assetKey,
      name: args.name,
      lid: args.lid,
    };
    const live: Live = {
      session,
      lent: args.lent,
      lentDisposed: false,
      // 開いた直後は「生きている」側に置く(同じ添付を続けて押しても 2 枚目を開かない)
      lastAliveAt: this.now(),
      helloTimer: null,
      attachLends: new Map(),
    };
    this.lives.set(token, live);
    live.helloTimer = this.setTimer(() => {
      // ⚠ ここへ来た = 窓が名乗らなかった。貸した URL をその場で捨てる
      live.helloTimer = null;
      if (this.lives.get(token) !== live) return;
      this.release(live);
      this.lives.delete(token);
      this.remember(token, { session, openFailed: true });
      this.deps.onOpenFailed(session);
    }, HELLO_TIMEOUT_MS);
    let url: string;
    try {
      url = new URL(PDF_HOST_PATH, this.baseUrl).href + `#${token}`;
      this.openWindow(url, WINDOW_FEATURES);
    } catch (e) {
      // 組み立て / 開くで落ちても貸出を漏らさない
      this.clearTimer(live.helloTimer);
      this.release(live);
      this.lives.delete(token);
      throw e;
    }
    return session;
  }

  dispose(): void {
    for (const l of [...this.lives.values()]) {
      if (l.helloTimer !== null) this.clearTimer(l.helloTimer);
      this.release(l);
      this.releaseAttach(l);
    }
    this.lives.clear();
    this.gone.clear();
    this.lending.clear();
    this.ch.onmessage = null;
    this.ch.close();
  }

  /** 貸した URL を返す(1 度だけ)。 */
  private release(l: Live): void {
    if (l.lentDisposed) return;
    l.lentDisposed = true;
    try {
      l.lent.dispose();
    } catch {
      // 戻せなかっただけ ── 呼び側を落とさない
    }
  }

  /** 窓へ貸している添付の URL を、全部返す(窓が閉じたとき / 本体が畳まれるとき)。 */
  private releaseAttach(l: Live): void {
    for (const [, a] of l.attachLends) {
      this.clearTimer(a.timer);
      try {
        a.lent.dispose();
      } catch {
        // 戻せなかっただけ
      }
    }
    l.attachLends.clear();
  }

  /** 窓へ貸した添付 1 件を返す(`attach-got` / 時間切れ)。 */
  private releaseAttachOne(l: Live, key: string): void {
    const a = l.attachLends.get(key);
    if (a === undefined) return;
    l.attachLends.delete(key);
    this.clearTimer(a.timer);
    try {
      a.lent.dispose();
    } catch {
      // 戻せなかっただけ
    }
  }

  private remember(token: string, g: Gone): void {
    this.gone.delete(token);
    this.gone.set(token, g);
    while (this.gone.size > GONE_KEEP) {
      const oldest = this.gone.keys().next();
      if (oldest.done) break;
      this.gone.delete(oldest.value);
    }
  }

  private send(kind: string, token: string, payload: unknown): void {
    this.ch.postMessage({ [PDF_TAG]: kind, token, payload });
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const m = data as Record<string, unknown>;
    const kind = m[PDF_TAG];
    const token = m['token'];
    if (typeof kind !== 'string' || typeof token !== 'string') return;
    // ⚠ 自分が開いた窓だけ受ける(他のタブの窓の合図は、そのタブが受ける)
    const live = this.lives.get(token);
    if (live === undefined) {
      /**
       * 🔴 **捨てた token が名乗り直した**(窓の F5 / 5 秒より遅い名乗り)。⚠ 直す前は**黙って捨て**て
       * いたので、窓は「読み込んでいます…」のまま固まった。貸した URL は返した後なので渡せない ──
       * **空で答えて窓に言わせる**(窓は「PKC3 のウィンドウから、もう一度開いてください」と出す)。
       */
      const g = this.gone.get(token);
      if (g !== undefined && kind === 'hello') {
        this.send('doc', token, { url: null, name: g.session.name });
        if (g.openFailed) {
          g.openFailed = false;
          this.deps.onLateHello(g.session);
        }
      }
      return;
    }
    const payload =
      typeof m['payload'] === 'object' && m['payload'] !== null
        ? (m['payload'] as Record<string, unknown>)
        : {};
    live.lastAliveAt = this.now();
    switch (kind) {
      case 'hello': {
        if (live.helloTimer !== null) {
          this.clearTimer(live.helloTimer);
          live.helloTimer = null;
        }
        // 🔴 貸した URL が既に返っていれば、渡せない(窓が読み直したとき)── 空で答えて窓に言わせる
        this.send('doc', token, {
          url: live.lentDisposed ? null : live.lent.url,
          name: live.session.name,
        });
        return;
      }
      case 'alive':
        return;
      case 'loaded':
        // 🔑 窓が Blob を握った ── ここが生成物の寿命の終端。窓の寿命まで握らない
        this.release(live);
        return;
      case 'fell-back':
        this.release(live);
        this.deps.onFellBack(live.session);
        return;
      case 'load-failed':
        this.release(live);
        this.deps.onLoadFailed(
          live.session,
          typeof payload['reason'] === 'string' ? payload['reason'] : '',
        );
        return;
      case 'quote': {
        const text = payload['text'];
        const page = payload['page'];
        if (typeof text !== 'string' || typeof page !== 'number') return;
        // 🔴 本体側が**最後の門**(窓の検めは親切であって、守りではない)
        if (utf8Length(text) > PDF_QUOTE_MAX_BYTES) {
          this.send('quote-result', token, { ok: false, message: PDF_QUOTE_TOO_LONG });
          return;
        }
        // 🔴 結末を待って返す(失敗しても窓へ理由を返す ── 窓を待たせ続けない)
        const reply = (r: PdfQuoteResult): void => {
          try {
            this.send('quote-result', token, { ok: r.ok, message: r.message });
          } catch {
            // 待っている間に放送を閉じた(本体の入れ替わり)── 返す先が無いだけ
          }
        };
        void this.deps.onQuote(live.session, text, page).then(reply, () =>
          reply({ ok: false, message: 'ノートへ引用できませんでした。もう一度押してください' }),
        );
        return;
      }
      case 'edited': {
        const key = payload['key'];
        if (typeof key !== 'string' || key === '') return;
        const reply = (r: PdfEditResult): void => {
          try {
            this.send('edit-result', token, { ok: r.ok, message: r.message, key });
          } catch {
            // 待っている間に放送を閉じた(本体の入れ替わり)── 返す先が無いだけ
          }
        };
        void this.deps.onEdited(live.session, key).then(reply, () =>
          reply({ ok: false, message: '保存できませんでした。もう一度押してください' }),
        );
        return;
      }
      case 'attach-list': {
        const reply = (body: { ok: boolean; items: readonly PdfAttachmentItem[] }): void => {
          try {
            this.send('attach-list-result', token, body);
          } catch {
            // 待っている間に放送を閉じた ── 返す先が無いだけ
          }
        };
        void this.deps.listAttachments().then(
          (items) =>
            reply({
              ok: true,
              items: items
                .slice(0, ATTACH_LIST_MAX)
                .map((i) => ({ key: i.key, name: i.name, size: i.size })),
            }),
          () => reply({ ok: false, items: [] }),
        );
        return;
      }
      case 'attach-get': {
        const key = payload['key'];
        if (typeof key !== 'string' || key === '' || key.length > ATTACH_KEY_MAX) return;
        const refuse = (): void => {
          try {
            this.send('attach-get-result', token, { ok: false, key, url: null });
          } catch {
            // 待っている間に放送を閉じた
          }
        };
        void this.deps.lendAttachment(key).then((lent) => {
          if (lent === null) {
            refuse();
            return;
          }
          // 待っている間に窓が閉じた / 畳まれた ── 貸さずに返す
          if (this.lives.get(token) !== live) {
            try {
              lent.dispose();
            } catch {
              // 戻せなかっただけ
            }
            return;
          }
          this.releaseAttachOne(live, key);
          live.attachLends.set(key, {
            lent,
            timer: this.setTimer(() => this.releaseAttachOne(live, key), ATTACH_LEND_TTL_MS),
          });
          try {
            this.send('attach-get-result', token, { ok: true, key, url: lent.url });
          } catch {
            this.releaseAttachOne(live, key);
          }
        }, refuse);
        return;
      }
      case 'attach-got': {
        // 🔑 窓が bytes を握った ── ここが貸した URL の寿命の終端
        const key = payload['key'];
        if (typeof key === 'string') this.releaseAttachOne(live, key);
        return;
      }
      case 'closed':
        if (live.helloTimer !== null) this.clearTimer(live.helloTimer);
        this.release(live);
        this.releaseAttach(live);
        this.lives.delete(token);
        // 窓の F5 は同じ token で名乗り直す ── 控えておき、黙らず答える
        this.remember(token, { session: live.session, openFailed: false });
        return;
      default:
        return;
    }
  }
}
