/**
 * 🔴 **ウィジェットのファイルの入出力の確認バー**(v4.1 Phase 1 / PR-4、#2097)。
 *
 * 箱(`sandbox="allow-scripts"` のみ ── `allow-downloads` も付けない)は、ファイルを保存することも、
 * ファイルを選ぶ画面を開くこともできない。箱は親へ頼み(`pkc-widget-dl-req` / `pkc-widget-file-req`)、
 * 親は**箱の直前に確認バーを出し、user が押したときだけ**保存する / 選ばせる。
 *
 * ## 🔴 セキュリティの不変条件
 *
 * - 送り主は `resolveSandboxSender`(`event.source === iframe.contentWindow` + 名乗りの照合)だけで決める
 *   (`event.origin` は使わない)。
 * - **自動では何もしない**(ドライブバイ・ダウンロードとファイル選択の連打を物理的に起こさない)。
 *   保存・添付・ファイル選択は、確認バーのボタンを user が押した処理の中でだけ走る。
 * - 1 つの箱に出す確認バーは**最新の 1 件だけ**。新しい要求が来たら前の要求には「置き換わりました」と答え、
 *   預かっていた bytes を手放す(UI を埋め尽くさせない・メモリを溜めない)。
 * - 流量は 1 つの箱につき 1 秒に 3 回まで(超えた分はバーを出さずに断る)。
 * - 「このノートへ添付」「このノートの添付から選ぶ」は、箱を置いた**読む面のノート 1 件**だけ(親の DOM から引いた lid)。
 *   埋め込み(別のノートの塊)の中の箱には出さない ── 他のノートの添付は見えない・選べない。
 * - 預かった bytes は、保存・添付・やめる・置き換え・箱が外れたときに手放す。ObjectURL は `downloadBlob` が破棄する。
 *
 * ## 定常のコスト
 *
 * - 箱が外れたかの見張り(`MutationObserver`)は**確認バーが 1 つでも出ている間だけ**付ける。
 *
 * ⚠ 判断(検証・上限・名前の無害化・答えの形)は `features/markdown/widget-io.ts` の純関数に置く ──
 *   ここは画面と配線だけ(次の PR で閲覧用 HTML にも同じ契約を持ち込む)。
 */
import { resolveSandboxSender } from '@features/markdown/html-sandbox';
import {
  checkWidgetPickedFiles,
  createWidgetIoRateLimiter,
  parseWidgetDownloadRequest,
  parseWidgetFileRequest,
  widgetAcceptLabel,
  widgetAcceptMatches,
  widgetDownloadResponse,
  widgetDownloadRiskNotice,
  widgetFileResponse,
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_IO_PRESS_GUARD_MS,
  WIDGET_IO_REASONS,
  WIDGET_IO_TIMEOUT_MS,
  reqIdOf,
  type WidgetDownloadRequest,
  type WidgetFileRequest,
  type WidgetIoFile,
  type WidgetIoRateLimiter,
} from '@features/markdown/widget-io';
import { humanBytes } from '@features/human-bytes';
import { downloadBlob } from '@adapter/platform/download';
import type { WidgetNoteAsset } from '@adapter/platform/widget-note-assets';

/** 確認バーの印。 */
export const WIDGET_IO_BAR_FIELD = 'widget-io-bar';

/** ノートとの口(`WidgetNoteHost` の一部。どれも無ければ PC との受け渡しだけになる)。 */
export interface WidgetIoHost {
  /** 本文を書けない理由の文(書けるなら `null`)。 */
  writeBlockReason(lid: string): string | null;
  /** 断りを知らせる。 */
  fail(message: string): void;
  /** ファイルをそのノートへ添付する(取り込みの門を通る正規の経路)。添付の処理が走ったら `true`。 */
  attachFile?(lid: string, file: File): Promise<boolean>;
  /** そのノートの添付(本文が使っている添付と、添付ノート自身のファイル)。 */
  listNoteAssets?(lid: string): Promise<readonly WidgetNoteAsset[]>;
  /** 添付の中身(⚠ 呼ぶのは `listNoteAssets` が返した鍵だけ)。 */
  readAssetBlob?(key: string): Promise<Blob | null>;
}

export interface WidgetIoContext {
  readonly host: WidgetIoHost | null;
  /** 箱を置いた読む面のノートの lid(取れない・埋め込みの中なら `null`)。 */
  readonly lidOf: (frame: HTMLIFrameElement) => string | null;
  /** test 用の時刻。 */
  readonly now?: () => number;
}

interface Pending {
  readonly frame: HTMLIFrameElement;
  readonly reqId: number;
  readonly kind: 'download' | 'file';
  readonly bar: HTMLElement;
  /** 預かっている bytes(保存の要求だけ)。⚠ 片付けで `null` にする。 */
  bytes: Uint8Array | null;
  settled: boolean;
  /** 添付・読み込みの最中(🔴 この間は新しい要求で置き換えない ── 添付したのに「置き換わりました」と返さない)。 */
  busy: boolean;
  /** 箱が諦める時間で、親も閉じる(預かった bytes を握り続けない)。 */
  timer: ReturnType<typeof setTimeout> | null;
}

/** 箱 → 出している確認バー(最新の 1 件)。 */
const pendings = new Map<HTMLIFrameElement, Pending>();
const limiters = new WeakMap<HTMLIFrameElement, WidgetIoRateLimiter>();
let watcher: MutationObserver | null = null;
/** 一覧の radio の組の名前(画面の中で重ならないように数える)。 */
let pickerSeq = 0;
/** 確認バーを出した直後に押せない時間(test は 0 にできる)。 */
let pressGuardMs = WIDGET_IO_PRESS_GUARD_MS;

/** test 用:押せない時間を差し替える(`null` で既定へ戻す)。 */
export function setWidgetIoPressGuardForTest(ms: number | null): void {
  pressGuardMs = ms ?? WIDGET_IO_PRESS_GUARD_MS;
}

/** test 用:その箱の確認バーの保留(片付けた後も持ち続けて、bytes を手放したかを見る)。 */
export function widgetIoPendingForTest(frame: HTMLIFrameElement): { readonly bytes: Uint8Array | null; readonly busy: boolean } | undefined {
  return pendings.get(frame);
}

/** test 用:出している確認バーの数。 */
export function widgetIoPendingCount(): number {
  return pendings.size;
}

/** test 用:すべて片付ける(答えは返さない)。 */
export function resetWidgetIoForTest(): void {
  for (const p of [...pendings.values()]) release(p);
  watcher?.disconnect();
  watcher = null;
}

function postTo(frame: HTMLIFrameElement, msg: Record<string, unknown>, transfer: Transferable[] = []): void {
  const w = frame.contentWindow;
  if (w === null) return;
  try {
    w.postMessage(msg, '*', transfer);
  } catch {
    // 外れかけの箱でも落ちない
  }
}

/** 片付け(バーを外し、bytes を手放す)。答えは返さない。 */
function release(p: Pending): void {
  p.settled = true;
  p.bytes = null;
  if (p.timer !== null) clearTimeout(p.timer);
  p.timer = null;
  p.bar.remove();
  if (pendings.get(p.frame) === p) pendings.delete(p.frame);
  if (pendings.size === 0) {
    watcher?.disconnect();
    watcher = null;
  }
}

/** 答えを返して片付ける(1 回だけ)。 */
function settle(p: Pending, msg: Record<string, unknown>, transfer: Transferable[] = []): void {
  if (p.settled) return;
  release(p);
  postTo(p.frame, msg, transfer);
}

function cancelMessage(p: Pending, reason: string): Record<string, unknown> {
  return p.kind === 'download'
    ? widgetDownloadResponse(p.reqId, false, 'cancel', reason)
    : widgetFileResponse(p.reqId, false, [], reason);
}

/** 🔴 箱が外れたら、出している確認バーと預かった bytes を片付ける(バーが在る間だけ見張る)。 */
function watchDetach(doc: Document): void {
  if (watcher !== null || typeof MutationObserver !== 'function') return;
  const mo = new MutationObserver(() => sweepWidgetIo());
  mo.observe(doc.documentElement, { childList: true, subtree: true });
  watcher = mo;
}

/** 外れた箱の確認バーを片付ける(見張りから呼ぶ。test からも呼べる)。 */
export function sweepWidgetIo(): number {
  let n = 0;
  for (const p of [...pendings.values()]) {
    if (p.frame.isConnected) continue;
    settle(p, cancelMessage(p, WIDGET_IO_REASONS.closed));
    n += 1;
  }
  return n;
}

function button(doc: Document, label: string, field: string, variant: 'ghost' | null, title?: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('data-pkc-field', field);
  if (variant !== null) b.setAttribute('data-pkc-variant', variant);
  if (title !== undefined) b.title = title;
  return b;
}

/** 押した処理を親の他の操作へ流さない(本文の選択・ノートの切り替えを巻き込まない)。 */
function onPress(b: HTMLButtonElement, run: () => void): void {
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    run();
  });
}

/** 確認バーの骨組み(箱の直前に置く)。 */
function makeBar(frame: HTMLIFrameElement, kind: 'download' | 'file', text: string): {
  bar: HTMLElement;
  actions: HTMLElement;
} {
  const doc = frame.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'pkc-widget-io-bar';
  bar.setAttribute('data-pkc-field', WIDGET_IO_BAR_FIELD);
  bar.setAttribute('data-pkc-io-kind', kind);
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', kind === 'download' ? 'ウィジェットからの保存の確認' : 'ウィジェットからの読み込みの確認');
  const t = doc.createElement('span');
  t.className = 'pkc-widget-io-text';
  t.setAttribute('data-pkc-field', 'widget-io-text');
  t.textContent = text;
  const actions = doc.createElement('span');
  actions.className = 'pkc-widget-io-actions';
  bar.append(t, actions);
  frame.parentElement?.insertBefore(bar, frame);
  return { bar, actions };
}

/**
 * 新しい要求の前に、同じ箱の前の要求を「置き換わりました」で閉じる。
 * @returns 置き換えられない(前の要求が添付・読み込みの最中)なら `false`
 */
function replacePrevious(frame: HTMLIFrameElement): boolean {
  const prev = pendings.get(frame);
  if (prev === undefined) return true;
  if (prev.busy) return false;
  settle(prev, cancelMessage(prev, WIDGET_IO_REASONS.replaced));
  return true;
}

/** 確認バーを登録する(時間切れで閉じる)。 */
function register(p: Pending): void {
  pendings.set(p.frame, p);
  p.timer = setTimeout(() => {
    p.timer = null;
    settle(p, cancelMessage(p, WIDGET_IO_REASONS.timeout));
  }, WIDGET_IO_TIMEOUT_MS);
  watchDetach(p.frame.ownerDocument);
}

/**
 * 🔴 **出した直後は押せない**(差し替えによるすり替え対策)。押せるボタンだけを止め、時間が来たら戻す
 * (書けない理由で止めてあるボタンは止めたまま)。
 */
function armAfterGuard(p: Pending, actions: HTMLElement): void {
  if (pressGuardMs <= 0) return;
  const held = [...actions.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.disabled);
  for (const b of held) b.disabled = true;
  setTimeout(() => {
    if (p.settled) return;
    for (const b of held) b.disabled = false;
  }, pressGuardMs);
}

/** 流量の上限(1 つの箱ごと)。 */
function allowed(frame: HTMLIFrameElement, now: number): boolean {
  let l = limiters.get(frame);
  if (l === undefined) {
    l = createWidgetIoRateLimiter();
    limiters.set(frame, l);
  }
  return l.allow(now);
}

/** 書けない理由(書けるなら `null`)。添付の口が無い・lid が無いときも理由を返す。 */
function attachBlockReason(ctx: WidgetIoContext, lid: string | null): string | null {
  if (lid === null) return 'このウィジェットはノートの本文の中に無いため、添付できません';
  const h = ctx.host;
  if (h === null || h.attachFile === undefined) return 'いまは添付できません';
  return h.writeBlockReason(lid);
}

function showDownloadBar(frame: HTMLIFrameElement, req: WidgetDownloadRequest, ctx: WidgetIoContext): void {
  const doc = frame.ownerDocument;
  const { bar, actions } = makeBar(
    frame,
    'download',
    `ウィジェットがファイルの保存を求めています:「${req.name}」(${humanBytes(req.bytes.byteLength)})`,
  );
  const p: Pending = { frame, reqId: req.reqId, kind: 'download', bar, bytes: req.bytes, settled: false, busy: false, timer: null };
  register(p);
  const risk = widgetDownloadRiskNotice(req.name);
  if (risk !== null) {
    const r = doc.createElement('span');
    r.className = 'pkc-widget-io-risk';
    r.setAttribute('data-pkc-field', 'widget-io-risk');
    r.setAttribute('role', 'note');
    r.textContent = risk;
    bar.insertBefore(r, actions);
  }
  const save = button(doc, 'PC へ保存', 'widget-io-save', null, 'このファイルをパソコンにダウンロードします');
  onPress(save, () => {
    const bytes = p.bytes;
    if (p.settled || bytes === null) return;
    downloadBlob(req.name, new Blob([bytes as BlobPart], { type: req.mime }));
    settle(p, widgetDownloadResponse(req.reqId, true, 'save'));
  });
  actions.append(save);
  // 🔑 「このノートへ添付」は読む面のノートが分かり、添付の口が在るときだけ出す(書けない理由があれば押せずに理由を添える)
  const lid = ctx.lidOf(frame);
  if (lid !== null && ctx.host?.attachFile !== undefined) {
    const attach = button(doc, 'このノートへ添付', 'widget-io-attach', 'ghost');
    const blocked = attachBlockReason(ctx, lid);
    attach.disabled = blocked !== null;
    attach.title = blocked === null ? 'このファイルを、いま開いているノートに添付します' : `いまは添付できません。${blocked}`;
    onPress(attach, () => {
      const bytes = p.bytes;
      if (p.settled || bytes === null) return;
      const lidNow = ctx.lidOf(frame);
      const why = attachBlockReason(ctx, lidNow);
      if (why !== null || lidNow === null) {
        ctx.host?.fail(why ?? WIDGET_IO_REASONS.attachFailed);
        return;
      }
      const file = new File([bytes as BlobPart], req.name, { type: req.mime });
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      p.busy = true;
      void ctx
        .host!.attachFile!(lidNow, file)
        .catch(() => false)
        .then((ok) => {
          settle(
            p,
            ok
              ? widgetDownloadResponse(req.reqId, true, 'attach')
              : widgetDownloadResponse(req.reqId, false, 'cancel', WIDGET_IO_REASONS.attachFailed),
          );
        });
    });
    actions.append(attach);
  }
  const cancel = button(doc, 'やめる', 'widget-io-cancel', 'ghost');
  onPress(cancel, () => settle(p, widgetDownloadResponse(req.reqId, false, 'cancel')));
  actions.append(cancel);
  armAfterGuard(p, actions);
}

/** 選んだ物を箱へ渡す(buffer は Transferable ── 親の手元に残さない)。 */
function deliverFiles(p: Pending, files: WidgetIoFile[]): void {
  settle(
    p,
    widgetFileResponse(p.reqId, true, files),
    files.map((f) => f.data),
  );
}

async function readAll(list: readonly { name: string; mime: string; blob: Blob }[]): Promise<WidgetIoFile[]> {
  return Promise.all(
    list.map(async (x) => {
      const data = await x.blob.arrayBuffer();
      return { name: x.name, mime: x.mime || 'application/octet-stream', size: data.byteLength, data };
    }),
  );
}

function showFileBar(frame: HTMLIFrameElement, req: WidgetFileRequest, ctx: WidgetIoContext): void {
  const doc = frame.ownerDocument;
  const label = widgetAcceptLabel(req.accept);
  const { bar, actions } = makeBar(
    frame,
    'file',
    `ウィジェットがファイルの読み込みを求めています${label === null ? '' : `(対象: ${label})`}`,
  );
  const p: Pending = { frame, reqId: req.reqId, kind: 'file', bar, bytes: null, settled: false, busy: false, timer: null };
  register(p);
  const fail = (reason: string): void => settle(p, widgetFileResponse(req.reqId, false, [], reason));

  const pc = button(doc, 'PC から選ぶ', 'widget-io-pick-pc', null, 'パソコンのファイルを選んで、ウィジェットに渡します');
  onPress(pc, () => {
    if (p.settled) return;
    // 🔴 user が押した処理の中で開く(自動では開かない)
    const input = doc.createElement('input');
    input.type = 'file';
    if (req.accept !== '') input.accept = req.accept;
    input.multiple = req.multiple;
    input.style.display = 'none';
    input.setAttribute('data-pkc-field', 'widget-io-input');
    const done = (): void => input.remove();
    input.addEventListener('cancel', () => {
      done();
      fail(WIDGET_IO_REASONS.cancelled);
    });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      done();
      const bad = checkWidgetPickedFiles(files, req);
      if (bad !== null) {
        fail(bad);
        return;
      }
      // 🔴 `accept` はブラウザでは強制でない(「すべてのファイル」へ切り替えられる)── 親で検め直す
      if (files.some((x) => !widgetAcceptMatches(req.accept, x.name, x.type))) {
        fail(WIDGET_IO_REASONS.wrongType);
        return;
      }
      p.busy = true;
      void readAll(files.map((f) => ({ name: f.name, mime: f.type, blob: f })))
        .then((got) => {
          if (!p.settled) deliverFiles(p, got);
        })
        .catch(() => fail(WIDGET_IO_REASONS.readFailed));
    });
    bar.append(input);
    input.click();
  });
  actions.append(pc);

  // 🔑 「このノートの添付から選ぶ」── 読む面のノートの添付が 1 件以上あるときだけ出す(引けてから出す)
  const lid = ctx.lidOf(frame);
  const h = ctx.host;
  if (lid !== null && h !== null && h.listNoteAssets !== undefined && h.readAssetBlob !== undefined) {
    const list = h.listNoteAssets.bind(h);
    const read = h.readAssetBlob.bind(h);
    const note = button(doc, 'このノートの添付から選ぶ', 'widget-io-pick-note', 'ghost', 'このノートに添付してあるファイルから選んで、ウィジェットに渡します');
    note.hidden = true;
    void list(lid)
      .catch(() => [] as readonly WidgetNoteAsset[])
      .then((assets) => {
        if (p.settled) return;
        const cands = assets.filter((a) => widgetAcceptMatches(req.accept, a.name, a.mime) && a.size <= req.maxBytes);
        if (cands.length === 0) return;
        note.hidden = false;
        onPress(note, () => {
          if (p.settled || bar.querySelector('[data-pkc-field="widget-io-note-list"]') !== null) return;
          showNotePicker(p, bar, cands, req, read, fail);
        });
      });
    actions.append(note);
  }
  const cancel = button(doc, 'やめる', 'widget-io-cancel', 'ghost');
  onPress(cancel, () => fail(WIDGET_IO_REASONS.cancelled));
  actions.append(cancel);
  armAfterGuard(p, actions);
}

/** 確認バーの中の小さな一覧(このノートの添付だけ)。 */
function showNotePicker(
  p: Pending,
  bar: HTMLElement,
  cands: readonly WidgetNoteAsset[],
  req: WidgetFileRequest,
  read: (key: string) => Promise<Blob | null>,
  fail: (reason: string) => void,
): void {
  const doc = bar.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'pkc-widget-io-list';
  box.setAttribute('data-pkc-field', 'widget-io-note-list');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'このノートの添付');
  const inputs: { input: HTMLInputElement; asset: WidgetNoteAsset }[] = [];
  pickerSeq += 1;
  const group = `pkc-widget-io-${String(pickerSeq)}`;
  for (const a of cands) {
    const row = doc.createElement('label');
    row.className = 'pkc-widget-io-item';
    const input = doc.createElement('input');
    input.type = req.multiple ? 'checkbox' : 'radio';
    input.name = group;
    input.setAttribute('data-pkc-field', 'widget-io-note-asset');
    input.setAttribute('data-pkc-asset-key', a.key);
    const name = doc.createElement('span');
    name.textContent = `${a.name}(${humanBytes(a.size)})`;
    row.append(input, name);
    box.append(row);
    inputs.push({ input, asset: a });
  }
  const give = button(doc, '選んだ添付を渡す', 'widget-io-note-give', null);
  give.disabled = true;
  box.addEventListener('change', () => {
    give.disabled = !inputs.some((x) => x.input.checked);
  });
  onPress(give, () => {
    if (p.settled) return;
    const chosen = inputs.filter((x) => x.input.checked).map((x) => x.asset);
    const bad = checkWidgetPickedFiles(chosen, req);
    if (bad !== null) {
      fail(bad);
      return;
    }
    give.disabled = true;
    p.busy = true;
    void Promise.all(chosen.map(async (a) => ({ a, blob: await read(a.key) })))
      .then(async (got) => {
        if (got.some((g) => g.blob === null)) throw new Error('missing');
        return readAll(got.map((g) => ({ name: g.a.name, mime: g.a.mime, blob: g.blob! })));
      })
      .then((files) => {
        if (!p.settled) deliverFiles(p, files);
      })
      .catch(() => fail(WIDGET_IO_REASONS.readFailed));
  });
  box.append(give);
  bar.append(box);
}

/**
 * 🔴 **箱からのファイルの入出力の要求を受ける**(`installWidgetBridge` の受け口から呼ぶ)。
 * @returns この口が受け持つ種類の合図なら `true`(処理した・捨てたを問わない)
 */
export function handleWidgetIoMessage(
  doc: Document,
  source: MessageEventSource | null,
  d: Record<string, unknown>,
  ctx: WidgetIoContext,
): boolean {
  if (d.type !== WIDGET_DL_REQ_MSG_TYPE && d.type !== WIDGET_FILE_REQ_MSG_TYPE) return false;
  // 🔴 送り主は実体(contentWindow)で引き、名乗りと照合する ── どちらかで外れたら黙って捨てる(偽の箱へ答えない)
  const frame = typeof d.id === 'string' ? resolveSandboxSender(doc, source, d.id) : null;
  if (frame === null || !frame.isConnected || frame.parentElement === null) return true;
  const now = (ctx.now ?? Date.now)();
  const isDl = d.type === WIDGET_DL_REQ_MSG_TYPE;
  const reject = (reqId: number | null, reason: string): void => {
    if (reqId === null) return;
    postTo(frame, isDl ? widgetDownloadResponse(reqId, false, 'rejected', reason) : widgetFileResponse(reqId, false, [], reason));
  };
  // 🔴 流量の上限は中身を検める前に数える(壊れた要求の連打も数に入れる・断る要求の文字列を符号化しない)
  if (!allowed(frame, now)) {
    reject(reqIdOf(d), WIDGET_IO_REASONS.rateLimited);
    return true;
  }
  const parsed = isDl ? parseWidgetDownloadRequest(d) : parseWidgetFileRequest(d);
  if (!parsed.ok) {
    reject(parsed.reqId, parsed.reason);
    return true;
  }
  // 🔴 前の要求が添付・読み込みの最中なら置き換えない(添付したのに「置き換わりました」と返さない)
  if (!replacePrevious(frame)) {
    reject(parsed.req.reqId, WIDGET_IO_REASONS.busy);
    return true;
  }
  if (isDl) showDownloadBar(frame, parsed.req as WidgetDownloadRequest, ctx);
  else showFileBar(frame, parsed.req as WidgetFileRequest, ctx);
  return true;
}
