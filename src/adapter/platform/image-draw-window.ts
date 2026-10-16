/**
 * 画像に描き込む別ウィンドウ(#683 段③)。
 *
 * 🔴 **中央の本文を占有しない**(#300)── 別ウィンドウで開く。押した人は読んでいたノートを
 * 1 ドットも動かされない。
 *
 * ## 作り(`asset-window.ts` と同じ型)
 *
 * `about:blank` を開いて**こちら(本体)から中身を組む**。描く・取り消す・保存するの
 * 全部が本体のスクリプトで動くので、保存は**書込の権利を持つ本体がそのまま**添付にできる
 * (PDF / Office の窓のように棚へ置いて放送する往復が要らない)。
 * ⚠ 引き換えに、**本体のタブが閉じるとこの窓の操作は効かなくなる**(描きかけは失われる)。
 *   そのとき押したボタンが無反応にならないよう、窓の側に**小さな番人**(`GUARD_SCRIPT`)を置く
 *   ── 番人は窓自身の realm で動くので、本体が消えていても「元の画面が閉じられた」と言える。
 *
 * ## 🔴 開くのは押した瞬間(同期)、組むのは読み込んでから
 *
 * `await` を挟んでから `window.open` すると、Safari / Firefox は「押した操作の続き」と認めず
 * ポップアップを止める。だから `openImageDrawWindow` は**同期**で窓を開き(「読み込んでいます」)、
 * 画像を読んだあとで `start` が中身を組む。
 *
 * ## 🔴 メモリと寿命(不可侵指示 2026-07-27「生成物は寿命終端で破棄」)
 *
 * - 台は **canvas 1 枚**(画像 + 描いた線を焼く)。長いほうの辺は 4096px まで(`drawSize`)。
 *   画面での見かけの大きさは CSS で縮める(台は縮めない)
 * - 読み込んだ画像(`ImageBitmap`)・canvas・線の配列は、**保存したとき / やめたとき /
 *   ウィンドウが閉じられたとき**に必ず手放す(`release`)。ObjectURL は作らない
 *
 * ## 🔴 操作
 *
 * - マウス:ドラッグで描く / タッチ:**1 本指で描く**。**2 本目の指が触れたら描きかけは捨て**、
 *   全部の指が離れるまで描かない(拡大・移動の 2 本指操作は段階 1 では持たない)
 * - 線が 1 本も無いうちは「新しい画像として保存」を押せない。線があるときの「やめる」と
 *   ウィンドウの × は、捨ててよいか確かめる(窓の中の確認 / `beforeunload`)
 * - 🔴 **文字**:押した所に入力欄を出し、打って Enter(または別の所を押す)で確定、Esc でやめる。
 *   日本語の変換中の Enter は確定にしない(`shouldCommitText`)
 * - **モザイク**:四角でなぞった範囲を、粗い升目の平均色で塗る(元の画素は書き出した PNG に残らない)
 * - 選んでいる道具・色・太さは `aria-pressed` と、それを**見た目に写す CSS**の両方で示す
 */
import { errorText } from '@features/error-text';
import {
  DRAW_COLORS,
  clampPt,
  drawSize,
  isDrawable,
  mosaicCellFor,
  paintPenSegment,
  paintStroke,
  pushStroke,
  shouldCommitText,
  strokeWidthFor,
  textSizeFor,
  undoStroke,
  type DrawColor,
  type DrawThickness,
  type DrawTool,
  type Pt,
  type Stroke,
} from '@features/asset/image-draw';
import { waitForWindowClose } from './window-close';

/** 保存の結果。⚠ 断られたら窓は**開いたまま**(描いた線を失わせない)。 */
export type ImageDrawSaveResult = { ok: true } | { ok: false; message: string };

export interface ImageDrawWindow {
  /** 窓が閉じているか。 */
  readonly closed: boolean;
  /** 開いている窓を手前に出す(開き直さない)。 */
  focus(): void;
  close(): void;
  /** 画像を読み込んで、描ける形に組む。 */
  start(blob: Blob, save: (png: Blob) => Promise<ImageDrawSaveResult>): Promise<void>;
  /** 組めない理由を窓に出す(窓は閉じられる)。 */
  fail(message: string): void;
}

export interface ImageDrawWindowDeps {
  /** 窓の題名に使う添付の名前。⚠ 文字として入れる。 */
  title: string;
  windowName: string;
  /** 窓が閉じたとき(保存・やめる・× のどれでも 1 度だけ)。 */
  onClosed?: () => void;
  /**
   * 🔴 **描きかけ(保存していない線・打ちかけの文字)の有る無し**が変わったとき(#1087)。
   * 主ウィンドウの「離れますか」(`unload-guard`)へ繋ぐ ── 主ウィンドウが閉じる・読み直されると、この窓の保存は
   * 効かなくなる(上の ⚠)ので、描きかけが在る間は主ウィンドウ側でも確認を出す。保存・やめる・閉じるで false に戻る。
   */
  onDirty?: (dirty: boolean) => void;
  open?: (url: string, target: string, features: string) => Window | null;
  waitClose?: (win: { closed: boolean }) => Promise<void>;
  /** 画像を復号する口(既定 `createImageBitmap`)。⚠ test が差せる。 */
  createBitmap?: (blob: Blob) => Promise<ImageBitmap>;
}

/** 本体が消えているとき、保存・やめるを押した人へ理由を言う番人(窓自身の realm で動く)。 */
export const OPENER_GONE_TEXT = '元の画面が閉じられたので保存できません';
const GUARD_SCRIPT =
  "document.addEventListener('click',function(e){" +
  "var t=e.target;var b=t&&t.closest?t.closest('[data-pkc-field=\"image-draw-save\"],[data-pkc-field=\"image-draw-cancel\"]'):null;" +
  'if(!b)return;var o=window.opener;var gone=!o;' +
  'try{if(o&&o.closed)gone=true;}catch(_){gone=true;}' +
  'if(!gone)return;e.stopImmediatePropagation();e.preventDefault();' +
  "var s=document.querySelector('[data-pkc-field=\"image-draw-status\"]');" +
  `if(s){s.textContent='${OPENER_GONE_TEXT}';s.setAttribute('data-pkc-tone','error');}` +
  '},true);';

const CSS =
  'html,body{margin:0;height:100%;background:#1b1b1b;color:#ddd;font:13px system-ui,sans-serif}' +
  'body{display:flex;flex-direction:column}' +
  '[data-pkc-field="image-draw-bar"]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:none;' +
  'padding:6px 8px;background:#000;border-bottom:1px solid #444}' +
  '[data-pkc-field="image-draw-bar"] button{font:inherit;cursor:pointer;background:#333;color:#eee;' +
  'border:1px solid #555;border-radius:3px;padding:3px 10px}' +
  '[data-pkc-field="image-draw-bar"] button[aria-pressed="true"]{background:#eee;color:#111;' +
  'border-color:#fff;font-weight:bold}' +
  '[data-pkc-field="image-draw-bar"] button:disabled{opacity:.45;cursor:default}' +
  '[data-pkc-field="image-draw-sep"]{width:1px;height:18px;background:#555;margin:0 4px}' +
  '[data-pkc-field="image-draw-status"]{flex:1;min-width:8em;padding:0 6px}' +
  '[data-pkc-field="image-draw-status"][data-pkc-tone="error"]{color:#ff9a9a}' +
  '[data-pkc-field="image-draw-confirm"]{display:flex;gap:6px;align-items:center}' +
  '[data-pkc-field="image-draw-confirm"][hidden]{display:none}' +
  '[data-pkc-field="image-draw-save"]{margin-left:auto}' +
  '[data-pkc-field="image-draw-stage"]{flex:1;min-height:0;display:grid;grid-template:minmax(0,1fr) / minmax(0,1fr);place-items:center;overflow:hidden;padding:8px}' +
  '[data-pkc-field="image-draw-canvas"]{display:block;max-width:100%;max-height:100%;' +
  'touch-action:none;cursor:crosshair;background:#fff}' +
  '[data-pkc-field="image-draw-loading"]{margin:auto;padding:2rem}' +
  '[data-pkc-field="image-draw-text-input"]{position:fixed;z-index:10;margin:0;padding:0;border:1px dashed #09f;' +
  'background:rgba(255,255,255,.85);outline:none;font-family:system-ui,sans-serif;min-width:6em;line-height:1.2}';

const DRAW_COLOR_CSS = DRAW_COLORS;
const TOOLS: ReadonlyArray<{ tool: DrawTool; label: string }> = [
  { tool: 'pen', label: 'ペン' },
  { tool: 'arrow', label: '矢印' },
  { tool: 'rect', label: '四角' },
  { tool: 'text', label: '文字' },
  { tool: 'mosaic', label: 'モザイク' },
];
const COLORS: ReadonlyArray<{ color: DrawColor; label: string }> = [
  { color: 'red', label: '赤' },
  { color: 'black', label: '黒' },
  { color: 'blue', label: '青' },
  { color: 'yellow', label: '黄' },
];
const THICKNESSES: ReadonlyArray<{ thickness: DrawThickness; label: string }> = [
  { thickness: 'thin', label: '細い' },
  { thickness: 'thick', label: '太い' },
];

/**
 * 窓の中身を組み、操作を結ぶ。返す `release` は何度呼んでもよい。
 * @param leave 閉じる(保存し終えた / 捨てると決めた)。⚠ `beforeunload` の確認を外してから閉じる。
 */
async function build(
  win: Window,
  blob: Blob,
  save: (png: Blob) => Promise<ImageDrawSaveResult>,
  createBitmap: (b: Blob) => Promise<ImageDrawBitmap>,
  close: () => void,
  onDirty: (dirty: boolean) => void,
): Promise<() => void> {
  const doc = win.document;
  doc.body.textContent = '';

  const bar = doc.createElement('div');
  bar.setAttribute('data-pkc-field', 'image-draw-bar');
  const stage = doc.createElement('div');
  stage.setAttribute('data-pkc-field', 'image-draw-stage');
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('data-pkc-field', 'image-draw-canvas');
  stage.append(canvas);
  doc.body.append(bar, stage);
  const guard = doc.createElement('script');
  guard.textContent = GUARD_SCRIPT;
  doc.body.append(guard);

  const status = doc.createElement('span');
  status.setAttribute('data-pkc-field', 'image-draw-status');
  const say = (text: string, error = false): void => {
    status.textContent = text;
    if (error) status.setAttribute('data-pkc-tone', 'error');
    else status.removeAttribute('data-pkc-tone');
  };

  const button = (field: string, label: string, on: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.setAttribute('data-pkc-field', field);
    b.textContent = label;
    b.addEventListener('click', on);
    return b;
  };
  const sep = (): HTMLElement => {
    const s = doc.createElement('span');
    s.setAttribute('data-pkc-field', 'image-draw-sep');
    return s;
  };

  let tool: DrawTool = 'pen';
  let color: DrawColor = 'red';
  let thickness: DrawThickness = 'thin';
  let strokes: readonly Stroke[] = [];
  let live: Stroke | null = null;
  let bitmap: ImageDrawBitmap | null = null;
  let released = false;
  let saving = false;
  let leaving = false;
  /** 打っている最中の文字の入力欄と、置く位置・色・大きさ。 */
  let textInput: HTMLInputElement | null = null;
  let textPlacement: { at: Pt; color: DrawColor; px: number } | null = null;
  let loaded = false;
  let frame: number | null = null;

  const toolButtons = new Map<DrawTool, HTMLButtonElement>();
  const colorButtons = new Map<DrawColor, HTMLButtonElement>();
  const thicknessButtons = new Map<DrawThickness, HTMLButtonElement>();
  // 確認の行(線があるときの「やめる」)
  const confirmRow = doc.createElement('span');
  confirmRow.setAttribute('data-pkc-field', 'image-draw-confirm');
  confirmRow.hidden = true;

  const undoBtn = button('image-draw-undo', '元に戻す', () => {
    if (saving) return;
    strokes = undoStroke(strokes);
    live = null;
    repaint();
    sync();
  });
  const saveBtn = button('image-draw-save', '新しい画像として保存', () => void doSave());
  const cancelBtn = button('image-draw-cancel', 'やめる', () => {
    if (saving) return;
    commitText();
    if (strokes.length === 0) {
      leave();
      return;
    }
    // 線を捨てることになる ── 窓の中で確かめる(`window.confirm` は使わない)
    confirmRow.hidden = false;
    say('', false);
  });

  let dirtyReported = false;
  const reportDirty = (dirty: boolean): void => {
    if (dirty === dirtyReported) return;
    dirtyReported = dirty;
    onDirty(dirty);
  };

  const sync = (): void => {
    for (const [t, b] of toolButtons) b.setAttribute('aria-pressed', String(t === tool));
    for (const [c, b] of colorButtons) b.setAttribute('aria-pressed', String(c === color));
    for (const [k, b] of thicknessButtons) b.setAttribute('aria-pressed', String(k === thickness));
    undoBtn.disabled = saving || strokes.length === 0;
    // 線が 1 本も無いまま保存すると、元と同じ画像が増えるだけ
    // ⚠ 打ちかけの文字があれば押せる(押すと確定してから保存する)
    const typing = textInput !== null && textInput.value.trim() !== '';
    saveBtn.disabled = saving || !loaded || (strokes.length === 0 && !typing);
    // 押せない理由を言う(何も描いていないときだけ。保存中・読み込み中は別の理由)
    saveBtn.title =
      !saving && loaded && strokes.length === 0 && !typing
        ? '線・矢印・四角・文字・モザイクのどれかを描くと押せます'
        : '';
    cancelBtn.disabled = saving;
    if (strokes.length === 0) confirmRow.hidden = true;
    reportDirty(!released && (strokes.length > 0 || typing));
  };

  /** 打っている文字を確定する(空なら何も置かない)。入力欄は必ず外す。 */
  function commitText(): void {
    const input = textInput;
    const placed = textPlacement;
    if (input === null || placed === null) return;
    textInput = null;
    textPlacement = null;
    const text = input.value;
    input.remove();
    if (released) return;
    const s: Stroke = { tool: 'text', color: placed.color, size: placed.px, at: placed.at, text };
    if (!isDrawable(s)) return;
    strokes = pushStroke(strokes, s);
    repaint();
    sync();
  }
  function cancelText(): void {
    const input = textInput;
    textInput = null;
    textPlacement = null;
    input?.remove();
  }

  const leave = (): void => {
    leaving = true;
    close();
  };

  const discard = button('image-draw-discard', '捨てて閉じる', leave);
  const keep = button('image-draw-keep', '続ける', () => {
    confirmRow.hidden = true;
  });
  const ask = doc.createElement('span');
  ask.textContent = '描いた線を捨てて閉じますか';
  confirmRow.append(ask, discard, keep);

  // 左:やめる(保存から離す) / 道具 / 色 / 戻す / 知らせ / 右端:保存
  bar.append(cancelBtn, confirmRow, sep());
  for (const t of TOOLS) {
    const b = button(`image-draw-tool-${t.tool}`, t.label, () => {
      commitText();
      tool = t.tool;
      sync();
    });
    toolButtons.set(t.tool, b);
    bar.append(b);
  }
  bar.append(sep());
  for (const c of COLORS) {
    const b = button(`image-draw-color-${c.color}`, c.label, () => {
      color = c.color;
      sync();
    });
    colorButtons.set(c.color, b);
    bar.append(b);
  }
  bar.append(sep());
  for (const k of THICKNESSES) {
    const b = button(`image-draw-thickness-${k.thickness}`, k.label, () => {
      thickness = k.thickness;
      sync();
    });
    thicknessButtons.set(k.thickness, b);
    bar.append(b);
  }
  bar.append(sep(), undoBtn, status, saveBtn);
  sync();

  const ctx = (): CanvasRenderingContext2D | null => canvas.getContext('2d');

  const repaint = (): void => {
    const c = ctx();
    if (c === null || bitmap === null) return;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    for (const s of strokes) paintStroke(c, s);
    if (live !== null) paintStroke(c, live);
  };
  const scheduleRepaint = (): void => {
    if (frame !== null || released) return;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      if (!released) repaint();
    });
  };

  const release = (): void => {
    if (released) return;
    released = true;
    reportDirty(false);
    if (frame !== null) {
      try {
        win.cancelAnimationFrame(frame);
      } catch {
        // 窓が先に消えていても構わない
      }
      frame = null;
    }
    strokes = [];
    live = null;
    textInput?.remove();
    textInput = null;
    bitmap?.close();
    bitmap = null;
    // 寸法を 0 にすると、台の画素の確保が即座に手放される
    canvas.width = 0;
    canvas.height = 0;
  };

  // ---- 線があるまま × で閉じるときだけ、ブラウザの確認を出す ----
  win.addEventListener('beforeunload', (ev: Event) => {
    // ⚠ 打ちかけの文字(まだ線の一覧に入っていない)も、失うものに数える
    const typing = textInput !== null && textInput.value.trim() !== '';
    if (leaving || released || (strokes.length === 0 && !typing)) return;
    ev.preventDefault();
    (ev as BeforeUnloadEvent).returnValue = '';
  });

  // ---- 画像を読み込む ----
  try {
    const bm = await createBitmap(blob);
    if (bm.width < 1 || bm.height < 1) {
      bm.close();
      throw new Error('empty');
    }
    bitmap = bm;
  } catch {
    say('この画像は読み込めませんでした', true);
    for (const b of [...toolButtons.values(), ...colorButtons.values(), ...thicknessButtons.values()]) b.disabled = true;
    sync();
    return release;
  }
  loaded = true;
  const size = drawSize(bitmap.width, bitmap.height);
  canvas.width = size.width;
  canvas.height = size.height;
  if (size.scale < 1) {
    say(`大きな画像なので ${size.width}×${size.height} に縮めて保存します`);
  }
  repaint();
  sync();

  // ---- 描く ----
  const widthPx = (): number => strokeWidthFor(size.width, size.height, thickness);
  const cellPx = mosaicCellFor(size.width, size.height);
  /** いま触れている指(またはマウス)。2 本以上になったら描かない。 */
  const down = new Set<number>();
  let drawingId: number | null = null;
  let tainted = false;
  /** ペンの点。動かしている間は 1 本の配列へ足していく(毎回コピーしない)。 */
  let penPoints: Pt[] = [];

  /** 文字を置こうとしている位置(台の座標)。指を離すまで持つ。 */
  let textAt: Pt | null = null;

  /** 文字を打つ入力欄を、押した所に出す。 */
  const openTextInput = (ev: PointerEvent, at: Pt): void => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / canvas.width : 1;
    const px = textSizeFor(size.width, size.height, thickness);
    const input = doc.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pkc-field', 'image-draw-text-input');
    input.setAttribute('aria-label', '置く文字');
    input.style.left = `${ev.clientX}px`;
    input.style.top = `${ev.clientY}px`;
    input.style.fontSize = `${Math.max(10, px * scale)}px`;
    input.style.color = DRAW_COLOR_CSS[color];
    const placed = { at, color, px };
    textPlacement = placed;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (shouldCommitText(e)) {
        e.preventDefault();
        commitText();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelText();
      }
    });
    input.addEventListener('blur', () => commitText());
    input.addEventListener('input', () => sync());
    doc.body.append(input);
    textInput = input;
    input.focus();
  };

  const toCanvas = (ev: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect();
    const w = r.width > 0 ? r.width : 1;
    const h = r.height > 0 ? r.height : 1;
    return { x: ((ev.clientX - r.left) * canvas.width) / w, y: ((ev.clientY - r.top) * canvas.height) / h };
  };

  canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (saving || released) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    down.add(ev.pointerId);
    if (down.size > 1) {
      // 2 本目の指 ── 描きかけは捨て、全部の指が離れるまで描かない
      tainted = true;
      textAt = null;
      if (live !== null) {
        live = null;
        drawingId = null;
        repaint();
      }
      return;
    }
    if (tainted) return;
    ev.preventDefault();
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      // 捕まえられなくても描ける(窓の外へ出たときだけ途切れる)
    }
    commitText();
    const p = toCanvas(ev);
    drawingId = ev.pointerId;
    if (tool === 'pen') {
      penPoints = [p];
      live = { tool: 'pen', color, width: widthPx(), points: penPoints };
      const c = ctx();
      if (c !== null) paintPenSegment(c, live, 0);
    } else if (tool === 'text') {
      // 置くのは指を離したとき(押した瞬間に入力欄へ焦点を移すと、離した操作に取り返される)
      textAt = p;
    } else if (tool === 'mosaic') {
      const q = clampPt(p, canvas.width, canvas.height);
      live = { tool: 'mosaic', cell: cellPx, from: q, to: q };
    } else {
      live = { tool, color, width: widthPx(), from: p, to: p };
    }
  });

  canvas.addEventListener('pointermove', (ev: PointerEvent) => {
    if (released || live === null || ev.pointerId !== drawingId) return;
    const p = live.tool === 'mosaic' ? clampPt(toCanvas(ev), canvas.width, canvas.height) : toCanvas(ev);
    if (live.tool === 'pen') {
      penPoints.push(p);
      const c = ctx();
      if (c !== null) paintPenSegment(c, live, penPoints.length - 1);
    } else if (live.tool !== 'text') {
      live = { ...live, to: p };
      scheduleRepaint();
    }
  });

  const end = (ev: PointerEvent, commit: boolean): void => {
    down.delete(ev.pointerId);
    if (down.size === 0) tainted = false;
    if (tool === 'text' && textAt !== null && ev.pointerId === drawingId) {
      const at = textAt;
      textAt = null;
      drawingId = null;
      if (commit && !released) openTextInput(ev, at);
      return;
    }
    if (released || live === null || ev.pointerId !== drawingId) return;
    const done = live;
    live = null;
    drawingId = null;
    if (done.tool === 'pen') Object.freeze(done.points);
    if (commit && isDrawable(done)) strokes = pushStroke(strokes, done);
    // 捨てた線を台から消す / 確定した線を描き直す
    repaint();
    sync();
  };
  canvas.addEventListener('pointerup', (ev: PointerEvent) => end(ev, true));
  canvas.addEventListener('pointercancel', (ev: PointerEvent) => end(ev, false));
  // 捕まえた指を失ったら、そこで線を終える(押しっぱなしの記録が残って描けなくなるのを防ぐ)
  canvas.addEventListener('lostpointercapture', (ev: PointerEvent) => end(ev, true));

  doc.addEventListener('keydown', (ev: KeyboardEvent) => {
    // ⚠ 文字を打っている最中の Ctrl+Z は、入力欄の打ち消しに任せる(直前に描いた線を消さない)
    if (ev.target === textInput) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      undoBtn.click();
    }
  });

  // ---- 保存する ----
  const doSave = async (): Promise<void> => {
    commitText();
    if (saving || released || bitmap === null || strokes.length === 0) return;
    saving = true;
    sync();
    say('保存しています');
    let png: Blob | null;
    try {
      repaint();
      png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    } catch {
      png = null;
    }
    if (png === null) {
      saving = false;
      sync();
      say('画像を作れませんでした', true);
      return;
    }
    let result: ImageDrawSaveResult;
    try {
      result = await save(png);
    } catch (e) {
      result = { ok: false, message: `保存できませんでした(${errorText(e)})` };
    }
    if (result.ok) {
      leave();
      return;
    }
    // 断られた ── 線は残したまま、理由を出して押し直せるようにする
    saving = false;
    sync();
    say(result.message, true);
  };

  return release;
}

/** `ImageBitmap` のうち使う部分(test が差し替えやすいように)。 */
export interface ImageDrawBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/**
 * 画像に描き込む窓を**押した瞬間に**開く(組むのは `start`)。
 * @returns 開けたら窓、開けなければ `null`(ポップアップが止められた)。
 */
export function openImageDrawWindow(deps: ImageDrawWindowDeps): ImageDrawWindow | null {
  const open = deps.open ?? ((u, t, f) => globalThis.open?.(u, t, f) ?? null);
  const win = open('about:blank', deps.windowName, 'popup,width=1000,height=760');
  if (!win) return null;
  const waitClose = deps.waitClose ?? ((w) => waitForWindowClose(w));
  const createBitmap =
    deps.createBitmap ?? ((b: Blob) => createImageBitmap(b, { imageOrientation: 'from-image' }) as Promise<ImageDrawBitmap>);
  let release: (() => void) | null = null;
  let finished = false;
  const finish = (): void => {
    release?.();
    if (finished) return;
    finished = true;
    deps.onClosed?.();
  };
  const close = (): void => {
    finish();
    try {
      win.close();
    } catch {
      // 既に閉じている
    }
  };
  // 窓が × で閉じられたときも手放す(待ちは投げっぱなしにしない)
  void waitClose(win).then(finish, finish);

  const doc = win.document;
  doc.title = `${deps.title} に描き込む`;
  const style = doc.createElement('style');
  style.textContent = CSS;
  // 🔑 viewport を宣言する ── 無いと電話は 980px の幅で描いて縮める(読めない小ささになる)
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  doc.head.append(viewport);
  doc.head.append(style);
  const loading = doc.createElement('p');
  loading.setAttribute('data-pkc-field', 'image-draw-loading');
  loading.textContent = '画像を読み込んでいます';
  doc.body.append(loading);

  return {
    get closed(): boolean {
      return win.closed;
    },
    focus: () => {
      try {
        win.focus();
      } catch {
        // 手前に出せなくても害は無い
      }
    },
    close,
    async start(blob, save): Promise<void> {
      try {
        release = await build(win, blob, save, createBitmap, close, deps.onDirty ?? (() => undefined));
      } catch (e) {
        close();
        throw e;
      }
      // 組んでいる間に閉じられていたら、読み込んだ画像をここで手放す
      if (win.closed || finished) release();
    },
    fail(message: string): void {
      loading.textContent = message;
    },
  };
}
