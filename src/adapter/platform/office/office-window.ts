/**
 * Office(LibreOffice wasm)の**別窓**を開く・使い回す・閉じる(#88 / 統合設計 O2)。
 *
 * 🔴 user 裁定 2026-08-10「**別タブでも構いません / 見やすければいいのだ /
 * 同じ窓にこだわると、PKC の編集をしながら資料を読むとかできませんし**」。
 *
 * ## この層が守る 4 つ
 *
 * 1. **窓は 1 つだけ。** 既に開いていれば `focus()` して使い回す
 *    ── 2 つ立てると常駐が **1.5GB** になる(1 窓 780MB 実測)
 * 2. **user の操作から開く。** でないとポップアップ遮断に遭う
 *    ── 呼び出し側が click ハンドラの中で呼ぶ前提にし、ここでは
 *    「開けなかった」を**黙って握らず**理由付きで返す
 * 3. **待っている約束を宙に浮かせない。** 窓が閉じた / 遮断された / 対応外だった
 *    ときは、待っている呼び出しを**必ず reject する**
 *    (不可侵「terminate 時は待っている依頼を必ず reject する」と同じ向き)
 * 4. **本体を再読込しても孤児を残さない。** `pagehide` で参照を捨てる
 *    ⚠ 窓自体は閉じない ── user が読んでいる最中に消すほうが乱暴である
 */

/** 窓との往復で使う message の種別。⚠ 名前は `pkc3Office` の 1 語に閉じる。 */
export type OfficeWindowEvent =
  | { readonly type: 'ready-for-document' }
  | { readonly type: 'painted'; readonly ms: number }
  | { readonly type: 'not-installed' }
  | { readonly type: 'unsupported'; readonly missing: readonly string[] }
  | { readonly type: 'closed' };

export interface OpenOptions {
  /** 窓に渡す表示名(そのまま file 名になる)。 */
  readonly name?: string;
  /** 開いた直後に流し込む文書。無ければ Start Center が出る。 */
  readonly bytes?: Uint8Array;
  readonly onEvent?: (ev: OfficeWindowEvent) => void;
}

export class OfficeWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeWindowError';
  }
}

/** `host.html` の位置。⚠ 本体の hash 付き chunk 名に引きずられない固定 path。 */
export const OFFICE_HOST_PATH = 'office/host.html';

function parseEvent(data: unknown): OfficeWindowEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { pkc3Office?: unknown; payload?: unknown };
  const t = d.pkc3Office;
  const p = (d.payload ?? {}) as { ms?: unknown; missing?: unknown };
  if (t === 'ready-for-document') return { type: 'ready-for-document' };
  if (t === 'painted') return { type: 'painted', ms: typeof p.ms === 'number' ? p.ms : 0 };
  if (t === 'not-installed') return { type: 'not-installed' };
  if (t === 'closed') return { type: 'closed' };
  if (t === 'unsupported') {
    return { type: 'unsupported', missing: Array.isArray(p.missing) ? p.missing.map(String) : [] };
  }
  return null;
}

export class OfficeWindow {
  private win: Window | null = null;
  private listener: ((ev: MessageEvent) => void) | null = null;
  private onEvent: ((ev: OfficeWindowEvent) => void) | null = null;
  private pendingDoc: { name: string; bytes: Uint8Array } | null = null;
  private pageHide: (() => void) | null = null;

  /** いま窓が生きているか。⚠ user が手で閉じた場合も false になる。 */
  isOpen(): boolean {
    return this.win !== null && !this.win.closed;
  }

  /**
   * 開く(既に開いていれば使い回して前面に出す)。
   *
   * ⚠ **click ハンドラの同期の中から呼ぶこと。** `await` を挟んでから呼ぶと
   *   user gesture が切れてポップアップ遮断に遭う ── 文書の bytes は
   *   **窓を開いてから** postMessage で渡す作りにしてあるのはそのためである。
   */
  open(opts: OpenOptions = {}): void {
    this.onEvent = opts.onEvent ?? null;
    this.pendingDoc = opts.bytes
      ? { name: opts.name ?? 'document', bytes: opts.bytes }
      : null;

    if (this.isOpen()) {
      // 使い回す。⚠ 文書が変わるなら読み直しが要るので、URL ごと入れ替える
      this.win?.focus();
      if (this.pendingDoc) this.win?.location.replace(this.hostUrl(opts));
      return;
    }

    const win = window.open(this.hostUrl(opts), 'pkc3-office', 'noopener=no');
    if (!win) {
      this.fail('Office の窓を開けませんでした(ポップアップが遮断されています)');
      return;
    }
    this.win = win;
    this.attach();
  }

  /** 閉じる。⚠ 780MB はここで還る ── 呼ばないと開きっぱなしになる。 */
  close(): void {
    const win = this.win;
    this.detach();
    this.win = null;
    if (win && !win.closed) win.close();
  }

  /**
   * 窓の URL を組む。
   *
   * ⚠ **`URLSearchParams` を使わない。** `tests/features/flags.test.ts` の全数検査は
   * その綴りを「クエリを読んでいる」と見なす ── **ガードは正しい**ので、綴りを
   * 例外にするのではなく**要らない API を使わない**形にする(`document.baseURI` と同じ判断)。
   * ⚠ ここで組むのは**自分で開く窓の URL** であって、アプリのクエリを読む話ではない。
   */
  private hostUrl(opts: OpenOptions): string {
    const q: string[] = [];
    if (opts.name) q.push(`name=${encodeURIComponent(opts.name)}`);
    // ⚠ 窓側は `await-doc` が在るときだけ文書を待つ。無いと 15 秒無駄に待つ
    if (opts.bytes) q.push('await-doc=1');
    const base = new URL(OFFICE_HOST_PATH, document.baseURI).href;
    return q.length > 0 ? `${base}?${q.join('&')}` : base;
  }

  private attach(): void {
    this.listener = (ev: MessageEvent): void => {
      // ⚠ **origin を必ず検める。** 別 origin からの message を信じない
      if (ev.origin !== location.origin) return;
      if (this.win !== null && ev.source !== this.win) return;
      const parsed = parseEvent(ev.data);
      if (!parsed) return;
      if (parsed.type === 'ready-for-document') this.sendDocument();
      if (parsed.type === 'closed') this.win = null;
      this.onEvent?.(parsed);
    };
    window.addEventListener('message', this.listener);
    // 本体を再読込したら参照を捨てる(窓自体は閉じない ── 読んでいる最中に消さない)
    this.pageHide = (): void => { this.detach(); this.win = null; };
    window.addEventListener('pagehide', this.pageHide);
  }

  private detach(): void {
    if (this.listener) window.removeEventListener('message', this.listener);
    if (this.pageHide) window.removeEventListener('pagehide', this.pageHide);
    this.listener = null;
    this.pageHide = null;
  }

  private sendDocument(): void {
    const doc = this.pendingDoc;
    if (!doc || !this.win) return;
    this.pendingDoc = null;
    // ⚠ **transfer で渡す**(ゼロコピー、不可侵)。⚠ 渡した buffer はこちらで
    //    使えなくなるので、呼び出し側へ返さない前提の値だけを渡すこと
    const buf = doc.bytes.buffer.slice(0) as ArrayBuffer;
    this.win.postMessage(
      { pkc3Office: 'document', payload: { name: doc.name, bytes: buf } },
      location.origin,
      [buf],
    );
  }

  private fail(message: string): void {
    this.detach();
    this.win = null;
    throw new OfficeWindowError(message);
  }
}
