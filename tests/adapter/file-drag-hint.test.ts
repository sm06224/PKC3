/** @vitest-environment happy-dom */
/**
 * 🔴 外からファイルをドラッグして窓に入っている間だけ、線と状態の字が出る(#1380)。
 * 空振り防止: 出る回と出ない回(内部のドラッグ)の両方を同じ口で流す。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DROP_LINE_ATTACH,
  DROP_LINE_IMAGE_LINK,
  DROP_LINE_MIXED,
  FILE_DRAG_ATTR,
  FILE_DRAG_LABEL_FIELD,
  dropLineFor,
  fileDragHintLine,
  paintFileDragLabel,
  partitionDrop,
  setupFileDragHint,
  subscribeFileDragHint,
} from '../../src/adapter/ui/actions/file-drag-hint';
import { statusBarWithFileDrag, type StatusLineParts } from '../../src/adapter/ui/render/status-line';

const isImageMime = (m: string): boolean => m.startsWith('image/');

function ev(
  type: string,
  types: string[],
  target: EventTarget = document.body,
  items: { kind: string; type: string }[] = [{ kind: 'file', type: 'text/plain' }],
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, items } });
  target.dispatchEvent(e);
  return e;
}

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
});

function setup(overBody: (t: EventTarget | null) => boolean = () => false) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML = '<div id="a"></div><div id="b"></div><textarea id="t"></textarea>';
  document.body.append(root);
  let notified = 0;
  const un = subscribeFileDragHint(root, () => (notified += 1));
  const stop = setupFileDragHint(root, { overBody, isImageMime });
  off = () => {
    stop();
    un();
  };
  return { root, count: () => notified };
}

describe('ファイルのドラッグ中の線(#1380)', () => {
  it('Files の dragenter で線と字が出て、窓の外へ出ると消える(子要素をまたいでも点滅しない)', () => {
    const { root, count } = setup();
    const a = root.querySelector('#a')!;
    const b = root.querySelector('#b')!;
    ev('dragenter', ['Files'], a);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(true);
    expect(fileDragHintLine(root)).toBe(DROP_LINE_ATTACH);
    // a から b へ: b に入ってから a を出る(数えは 2 から 1)
    ev('dragenter', ['Files'], b);
    ev('dragleave', ['Files'], a);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(true);
    ev('dragleave', ['Files'], b);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    expect(fileDragHintLine(root)).toBe('');
    expect(count()).toBe(2); // 出る・消える の 2 回だけ
  });

  it('🔴 内側が stopPropagation しても数えが狂わない(capture で受ける)', () => {
    const { root } = setup();
    const a = root.querySelector('#a')!;
    const b = root.querySelector('#b')!;
    for (const el of [a, b]) {
      for (const t of ['dragenter', 'dragleave', 'drop']) {
        el.addEventListener(t, (e) => e.stopPropagation());
      }
    }
    ev('dragenter', ['Files'], a);
    ev('dragenter', ['Files'], b);
    ev('dragleave', ['Files'], a);
    expect(root.hasAttribute(FILE_DRAG_ATTR), 'b に入ったまま').toBe(true);
    ev('dragleave', ['Files'], b);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    // drop も内側が止めても畳まれる
    ev('dragenter', ['Files'], a);
    ev('drop', ['Files'], a);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
  });

  it('内部のドラッグ(PKC の荷物)では出ない。Files が無いときも出ない', () => {
    const { root } = setup();
    ev('dragenter', ['Files', 'application/x-pkc-lids']);
    ev('dragenter', ['application/x-pkc-block']);
    ev('dragenter', ['text/plain']);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    expect(fileDragHintLine(root)).toBe('');
  });

  it('🔴 窓の中で始まったドラッグ(<img> / リンク)は Files を載せていても出ない。終われば外のファイルは出る', () => {
    const { root } = setup();
    ev('dragstart', ['Files', 'text/uri-list'], root.querySelector('#a')!);
    ev('dragenter', ['Files', 'text/uri-list']);
    expect(root.hasAttribute(FILE_DRAG_ATTR), '内部ドラッグで線が出た').toBe(false);
    ev('dragend', ['Files']);
    ev('dragenter', ['Files']);
    expect(root.hasAttribute(FILE_DRAG_ATTR), '終わったあとの外のファイルで出ない').toBe(true);
  });

  it('drop / dragend / Escape / mousemove / pointermove のどれでも必ず消える', () => {
    const { root } = setup();
    const start = () => {
      ev('dragenter', ['Files']);
      expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(true);
    };
    start();
    ev('drop', ['Files']);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    start();
    ev('dragend', ['Files']);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    start();
    document.dispatchEvent(new Event('mousemove'));
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    start();
    document.dispatchEvent(new Event('pointermove'));
    expect(root.hasAttribute(FILE_DRAG_ATTR), 'pointermove で消えない').toBe(false);
    // 数えが残っていない: 次の 1 回で出て、1 回の leave で消える
    start();
    ev('dragleave', ['Files']);
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    // 対照群: Escape 以外のキーでは消えない
    start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(true);
  });

  it('🔴 状態は root ごと(別の root の状態を巻き込まない)・後始末で消える', () => {
    const { root } = setup();
    const other = document.createElement('div');
    document.body.append(other);
    ev('dragenter', ['Files']);
    expect(fileDragHintLine(root)).toBe(DROP_LINE_ATTACH);
    expect(fileDragHintLine(other)).toBe('');
    off?.();
    off = null;
    expect(root.hasAttribute(FILE_DRAG_ATTR)).toBe(false);
    expect(fileDragHintLine(root)).toBe('');
  });
});

describe('字は routeFiles と同じ振り分けで決まる(#1380 ⑤)', () => {
  const img = { kind: 'file', type: 'image/png' };
  const txt = { kind: 'file', type: 'text/plain' };

  it('partitionDrop: 本文の欄の上でだけ画像が分かれる', () => {
    const isImg = (x: { type: string }): boolean => isImageMime(x.type);
    expect(partitionDrop([img, txt], true, isImg)).toEqual({ images: [img], rest: [txt] });
    expect(partitionDrop([img, txt], false, isImg)).toEqual({ images: [], rest: [img, txt] });
  });

  it('字: 本文の欄=画像のリンク / 混在 / それ以外=添付', () => {
    expect(dropLineFor([img], true, isImageMime)).toBe(DROP_LINE_IMAGE_LINK);
    expect(dropLineFor([img, txt], true, isImageMime)).toBe(DROP_LINE_MIXED);
    expect(dropLineFor([txt], true, isImageMime)).toBe(DROP_LINE_ATTACH);
    expect(dropLineFor([img], false, isImageMime)).toBe(DROP_LINE_ATTACH);
  });

  it('入り先が本文の欄に変わると字が変わる(dragenter ごとに引き直す)', () => {
    const { root } = setup((t) => t instanceof HTMLTextAreaElement);
    const items = [{ kind: 'file', type: 'image/png' }];
    ev('dragenter', ['Files'], root.querySelector('#a')!, items);
    expect(fileDragHintLine(root)).toBe(DROP_LINE_ATTACH);
    ev('dragenter', ['Files'], root.querySelector('#t')!, items);
    expect(fileDragHintLine(root)).toBe(DROP_LINE_IMAGE_LINK);
  });
});

describe('出し先: ステータスバーが見えていればそこ、畳まれていれば畳んだままラベル(#1380 ①)', () => {
  const base: StatusLineParts = {
    phase: 'ready',
    statusBase: '',
    sync: '',
    portableAssetNote: '',
    persistState: '',
    savingLine: '',
    progressLine: '',
    noticeLine: '',
    errorLine: '',
    fileDragLine: DROP_LINE_ATTACH,
  };
  const ctx = { hasTooNarrow: false, hasUnreadMessages: false };

  it('ふだん(畳まれている)は畳んだまま、字はラベルへ', () => {
    expect(statusBarWithFileDrag(base, ctx)).toEqual({ text: '', hide: true, floating: DROP_LINE_ATTACH });
  });

  it('見えている(知らせがある)ときはそこに足す。ラベルは出さない', () => {
    const r = statusBarWithFileDrag({ ...base, noticeLine: 'コピーしました' }, ctx);
    expect(r.hide).toBe(false);
    expect(r.floating).toBe('');
    expect(r.text).toBe(`${DROP_LINE_ATTACH} — コピーしました`);
  });

  it('編集中(状態語がある)なら見えているのでバーに足す', () => {
    const r = statusBarWithFileDrag({ ...base, phase: 'editing' }, ctx);
    expect(r).toEqual({ text: `編集中 — ${DROP_LINE_ATTACH}`, hide: false, floating: '' });
  });

  it('ドラッグしていなければ今までどおり(畳まれたまま・ラベルなし)', () => {
    expect(statusBarWithFileDrag({ ...base, fileDragLine: '' }, ctx)).toEqual({
      text: '',
      hide: true,
      floating: '',
    });
  });

  it('ラベル: 出す・消す・同じ要素を使い続ける。左の一覧の下端に合わせる', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.innerHTML = '<div data-pkc-region="sidebar"></div>';
    document.body.append(root);
    const side = root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!;
    side.getBoundingClientRect = () =>
      ({ left: 0, right: 230, top: 0, bottom: 600, width: 230, height: 600, x: 0, y: 0 }) as DOMRect;
    const label = () => root.querySelector<HTMLElement>(`[data-pkc-field="${FILE_DRAG_LABEL_FIELD}"]`);
    expect(label()).toBeNull();
    paintFileDragLabel(root, DROP_LINE_ATTACH);
    expect(label()!.textContent).toBe(DROP_LINE_ATTACH);
    expect(label()!.hidden).toBe(false);
    expect(label()!.style.left).toBe('8px');
    expect(label()!.style.maxWidth).toBe('214px');
    const first = label();
    paintFileDragLabel(root, '');
    expect(label()!.hidden).toBe(true);
    paintFileDragLabel(root, DROP_LINE_ATTACH);
    expect(label()).toBe(first);
    expect(root.querySelectorAll(`[data-pkc-field="${FILE_DRAG_LABEL_FIELD}"]`).length).toBe(1);
  });
});

describe('🔴 配線と CSS の原文 pin(#1380)', () => {
  const noComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('C: main.ts が 3 つの配線を持つ(main.ts はどの test からも実行されない)', () => {
    const src = noComments(readFileSync('src/main.ts', 'utf-8'));
    expect(src).toContain('subscribeFileDragHint(root, paint)');
    expect(src).toContain('fileDragLine: fileDragHintLine(root)');
    expect(src).toContain('paintFileDragLabel(root, floating)');
    expect(src).toContain('statusBarWithFileDrag(parts');
    const binder = noComments(readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8'));
    expect(binder).toContain('setupFileDragHint(root, {');
    expect(binder).toContain('partitionDrop(files, inBody, isImageFile)');
  });

  it('D: 線の CSS は [data-pkc-file-drag] 条件つきだけ。ふだんの規則には outline を足さない', () => {
    const css = noComments(readFileSync('src/styles/app.css', 'utf-8'));
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      sel: m[1]!.trim(),
      body: m[2]!,
    }));
    const lines = rules.filter(
      (r) =>
        r.sel.includes("[data-pkc-file-drag]") &&
        /outline:\s*2px solid var\(--accent\)/.test(r.body),
    );
    expect(lines.length, '線の規則が無い').toBeGreaterThan(0);
    const selectors = lines.flatMap((r) => r.sel.split(',').map((x) => x.trim()));
    expect(selectors).toEqual(
      expect.arrayContaining([
        "[data-pkc-file-drag] [data-pkc-region='sidebar']",
        "[data-pkc-file-drag] [data-pkc-region='center']",
      ]),
    );
    for (const sel of selectors) expect(sel.startsWith('[data-pkc-file-drag] ')).toBe(true);
    // 条件なしの sidebar / center の規則には outline が無い
    const plain = rules.filter((r) => /^\[data-pkc-region='(sidebar|center)'\]$/.test(r.sel));
    expect(plain.length).toBeGreaterThan(0);
    for (const r of plain) expect(r.body, r.sel).not.toMatch(/outline/);
    // ラベルは重ねても配置を動かさない・操作を奪わない
    const label = rules.find((r) => r.sel === "[data-pkc-field='file-drag-label']")!;
    expect(label.body).toMatch(/position:\s*fixed/);
    expect(label.body).toMatch(/pointer-events:\s*none/);
    expect(label.body).toMatch(/white-space:\s*nowrap/);
  });
});
