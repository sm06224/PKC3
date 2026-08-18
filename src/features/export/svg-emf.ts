/**
 * SVG(mermaid の出力)を EMF のベクタ記録へ起こす(#199 / #238)。
 *
 * > user 指示 2026-08-17「**フローチャートのようないじれそうなものは emf とか wmf に
 * > して欲しい**」
 *
 * ## なぜ自前なのか(2026-08-17 の実測)
 *
 * | 変換 | 結果 |
 * |---|---|
 * | LibreOffice に SVG→EMF させる | ❌ **箱が真っ黒・文字が消える**(mermaid の CSS を解決しない) |
 * | クラスを素朴にインライン化してから渡す | ❌ 同じ(子孫セレクタを拾えない) |
 * | **ここ**(CSS カスケードごと自前で解決) | ✅ |
 *
 * ## 受ける範囲(mermaid の出力を実測して決めた)
 *
 * `transform` は **translate / scale / rotate / matrix**、path の命令は
 * **M L H V C S Q T Z**(⚠ 実測では **A(円弧)は 1 件も出ない**が、来たら
 * 終点まで直線で結んで**落とさない**)、要素は rect / circle / ellipse /
 * polygon / polyline / line / path / text / tspan / marker(矢尻)。
 * ⚠ `foreignObject` は**出ない**(`htmlLabels: false` が効いている)。
 */
import { parseXml, textOf, type XmlNode } from './xml-lite';
import { computeStyle, parseColor, parseCss, parseLength, type CssRule, type Style } from './svg-style';
import { EmfWriter, SCALE, TA, type Point } from './emf';

/** 2 次元アフィン変換 `[a b c d e f]`(SVG と同じ並び)。 */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** 変換の平均倍率(線の太さと字の大きさに使う)。 */
function scaleOf(m: Matrix): number {
  return (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
}

/** `translate(1,2) scale(3)` のような並びを 1 つの行列にする。 */
export function parseTransform(text: string | undefined): Matrix {
  if (!text) return IDENTITY;
  let out: Matrix = IDENTITY;
  const re = /(translate|scale|rotate|matrix)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const args = m[2]!
      .split(/[\s,]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    switch (m[1]) {
      case 'translate':
        out = multiply(out, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
        break;
      case 'scale':
        out = multiply(out, [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]);
        break;
      case 'rotate': {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const cx = args[1] ?? 0;
        const cy = args[2] ?? 0;
        out = multiply(out, [1, 0, 0, 1, cx, cy]);
        out = multiply(out, [cos, sin, -sin, cos, 0, 0]);
        out = multiply(out, [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'matrix':
        if (args.length >= 6) out = multiply(out, args.slice(0, 6) as unknown as Matrix);
        break;
      default:
        break;
    }
  }
  return out;
}

/** path の 1 区間。曲線は 3 次ベジェへ寄せる(EMF が直に持てる形)。 */
interface SubPath {
  readonly start: Point;
  readonly segs: ({ kind: 'line'; to: Point } | { kind: 'bezier'; c1: Point; c2: Point; to: Point })[];
  closed: boolean;
}

/**
 * `d` を区間へ分解する。⚠ **相対命令**(小文字)も受ける ── mermaid は `l` を使う。
 */
export function parsePath(d: string): SubPath[] {
  const out: SubPath[] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cur: Point = { x: 0, y: 0 };
  let startPt: Point = { x: 0, y: 0 };
  let sub: SubPath | null = null;
  let prevCtrl: Point | null = null;
  let cmd = '';
  const num = (): number => Number(tokens[i++] ?? 0);
  const push = (seg: SubPath['segs'][number]): void => {
    if (!sub) {
      sub = { start: cur, segs: [], closed: false };
      out.push(sub);
    }
    sub.segs.push(seg);
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(t)) {
      cmd = t;
      i += 1;
    }
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num() + base.x;
        const y = num() + base.y;
        cur = { x, y };
        startPt = cur;
        sub = { start: cur, segs: [], closed: false };
        out.push(sub);
        cmd = rel ? 'l' : 'L';
        prevCtrl = null;
        break;
      }
      case 'L': {
        const x = num() + base.x;
        const y = num() + base.y;
        cur = { x, y };
        push({ kind: 'line', to: cur });
        prevCtrl = null;
        break;
      }
      case 'H': {
        const x = num() + (rel ? cur.x : 0);
        cur = { x, y: cur.y };
        push({ kind: 'line', to: cur });
        prevCtrl = null;
        break;
      }
      case 'V': {
        const y = num() + (rel ? cur.y : 0);
        cur = { x: cur.x, y };
        push({ kind: 'line', to: cur });
        prevCtrl = null;
        break;
      }
      case 'C': {
        const c1 = { x: num() + base.x, y: num() + base.y };
        const c2 = { x: num() + base.x, y: num() + base.y };
        const to = { x: num() + base.x, y: num() + base.y };
        push({ kind: 'bezier', c1, c2, to });
        prevCtrl = c2;
        cur = to;
        break;
      }
      case 'S': {
        const c2 = { x: num() + base.x, y: num() + base.y };
        const to = { x: num() + base.x, y: num() + base.y };
        const c1 = prevCtrl ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : cur;
        push({ kind: 'bezier', c1, c2, to });
        prevCtrl = c2;
        cur = to;
        break;
      }
      case 'Q':
      case 'T': {
        let q: Point;
        if (cmd.toUpperCase() === 'Q') {
          q = { x: num() + base.x, y: num() + base.y };
        } else {
          q = prevCtrl ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : cur;
        }
        const to = { x: num() + base.x, y: num() + base.y };
        // 2 次 → 3 次へ寄せる(EMF は 3 次しか持てない)
        const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
        const c2 = { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) };
        push({ kind: 'bezier', c1, c2, to });
        prevCtrl = q;
        cur = to;
        break;
      }
      case 'A': {
        // ⚠ 実測では出ないが、来たら**終点まで直線**で結ぶ(黙って消さない)
        num();
        num();
        num();
        num();
        num();
        const to = { x: num() + base.x, y: num() + base.y };
        push({ kind: 'line', to });
        cur = to;
        prevCtrl = null;
        break;
      }
      case 'Z': {
        if (sub) sub.closed = true;
        cur = startPt;
        sub = null;
        prevCtrl = null;
        break;
      }
      default:
        i += 1;
        break;
    }
  }
  return out.filter((s) => s.segs.length > 0);
}

interface Paint {
  readonly fill: number | null;
  readonly stroke: number | null;
  readonly strokeWidth: number;
  readonly dashed: boolean;
}

function paintOf(style: Style, m: Matrix): Paint {
  // ⚠ **`none` の判定は `parseColor` の 1 か所だけ**に置く(#238 の変異試験で、
  //    ここに二重の門を書いたら片方を壊しても誰も気づかない形になった)
  const fill = parseColor(style['fill']);
  const stroke = parseColor(style['stroke']);
  const em = parseLength(style['font-size'], 16, 16);
  const w = parseLength(style['stroke-width'], em, 1);
  const dash = (style['stroke-dasharray'] ?? '').trim();
  return {
    fill,
    stroke,
    strokeWidth: Math.max(0, w * scaleOf(m)) * SCALE,
    dashed: dash !== '' && dash !== '0' && dash !== 'none',
  };
}

/** 実際に描く(塗り → 線)。⚠ どちらも無いときは**何もしない**。 */
function drawShape(w: EmfWriter, paint: Paint, run: (mode: 'fill' | 'stroke' | 'both') => void): void {
  if (paint.fill === null && paint.stroke === null) return;
  const pen = w.selectPen({ color: paint.stroke, width: paint.strokeWidth, dashed: paint.dashed });
  const brush = w.selectBrush({ color: paint.fill });
  run(paint.fill !== null && paint.stroke !== null ? 'both' : paint.fill !== null ? 'fill' : 'stroke');
  w.deleteObject(pen);
  w.deleteObject(brush);
}

const P = (m: Matrix, x: number, y: number): Point => {
  const p = apply(m, x, y);
  return { x: p.x * SCALE, y: p.y * SCALE };
};

export interface SvgToEmfResult {
  readonly bytes: Uint8Array;
  /** 何を描いたか(空振り防止 ── 0 件なら呼び側が気づける)。 */
  readonly counts: { shapes: number; texts: number };
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * SVG の文字列を EMF のバイト列にする。
 * ⚠ **1 つも描けなかったときは投げる** ── 空の EMF を「書けた」と言わない。
 */
export function svgToEmf(svgText: string): SvgToEmfResult {
  const root = parseXml(svgText);
  if (root.tag !== 'svg') throw new Error(`根が <svg> ではありません: <${root.tag}>`);

  // 版面。⚠ viewBox を正とする(width/height は `100%` のことがある)
  const vb = (root.attrs['viewBox'] ?? '').trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every((n) => Number.isFinite(n));
  const width = hasVb ? vb[2]! : parseLength(root.attrs['width'], 16, 300);
  const height = hasVb ? vb[3]! : parseLength(root.attrs['height'], 16, 200);
  const originX = hasVb ? vb[0]! : 0;
  const originY = hasVb ? vb[1]! : 0;

  const rules: CssRule[] = [];
  const markers = new Map<string, XmlNode>();
  (function collect(node: XmlNode): void {
    if (node.tag === 'style') rules.push(...parseCss(textOf(node)));
    if (node.tag === 'marker' && node.attrs['id']) markers.set(node.attrs['id']!, node);
    for (const c of node.children) collect(c);
  })(root);

  const w = new EmfWriter(width, height);
  const counts = { shapes: 0, texts: 0 };
  const base: Matrix = [1, 0, 0, 1, -originX, -originY];

  /** 直前に描いた線の終点と向き(marker を置くのに要る)。 */
  const drawPath = (node: XmlNode, style: Style, m: Matrix): void => {
    const subs = parsePath(node.attrs['d'] ?? '');
    if (subs.length === 0) return;
    const paint = paintOf(style, m);
    if (paint.fill === null && paint.stroke === null) return;
    drawShape(w, paint, (mode) => {
      w.pathBegin();
      for (const sub of subs) {
        w.moveTo(P(m, sub.start.x, sub.start.y));
        for (const seg of sub.segs) {
          if (seg.kind === 'line') w.lineTo(P(m, seg.to.x, seg.to.y));
          else w.bezierTo([P(m, seg.c1.x, seg.c1.y), P(m, seg.c2.x, seg.c2.y), P(m, seg.to.x, seg.to.y)]);
        }
        if (sub.closed) w.closeFigure();
      }
      w.pathEnd(mode);
    });
    counts.shapes += 1;

    // 矢尻(marker-end / marker-start)
    const endRef = /url\(#([^)]+)\)/.exec(style['marker-end'] ?? node.attrs['marker-end'] ?? '');
    if (endRef) {
      const last = subs[subs.length - 1]!;
      const tail = last.segs[last.segs.length - 1]!;
      const to = tail.to;
      const from = tail.kind === 'bezier' ? tail.c2 : last.segs.length > 1 ? prevPoint(last) : last.start;
      drawMarker(endRef[1]!, to, Math.atan2(to.y - from.y, to.x - from.x), m);
    }
  };

  const prevPoint = (sub: SubPath): Point => {
    const before = sub.segs[sub.segs.length - 2]!;
    return before.to;
  };

  /** marker(矢尻)を終点へ、向きに合わせて置く。 */
  const drawMarker = (id: string, at: Point, angle: number, m: Matrix): void => {
    const marker = markers.get(id);
    if (!marker) return;
    const refX = Number(marker.attrs['refX'] ?? 0) || 0;
    const refY = Number(marker.attrs['refY'] ?? 0) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // ⚠ **marker の座標系** → 回転 → 終点へ平行移動、の順で合成する
    // ⚠ 順序が命 ── **ref を原点へ寄せて → 向きに回して → 終点へ置く**。
    //   逆にすると、90° の矢だけ正しく見えて斜めの矢が化ける(気づけない形)。
    const local: Matrix = multiply([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -refX, -refY]);
    const full = multiply(multiply(m, [1, 0, 0, 1, at.x, at.y]), local);
    for (const child of marker.children) {
      if (child.tag === 'path' || child.tag === 'polygon') {
        const style = computeStyle([root, marker, child], rules);
        // ⚠ marker は既定で**線の色**で塗る ── mermaid は `.marker{fill:…}` を持つ
        emitElement(child, style, full);
      }
    }
  };

  /** 文字を置く。⚠ 位置は tspan で積み上がる(`x` / `y` / `dx` / `dy`)。 */
  const drawText = (node: XmlNode, style: Style, m: Matrix): void => {
    const em = parseLength(style['font-size'], 16, 16);
    const color = parseColor(style['fill']) ?? 0x000000;
    const anchor = (style['text-anchor'] ?? 'start').trim();
    const face = (style['font-family'] ?? 'sans-serif').split(',')[0]!.replace(/["']/g, '').trim();
    const bold = /^(bold|[6-9]00)$/.test((style['font-weight'] ?? '').trim());
    const italic = (style['font-style'] ?? '').trim() === 'italic';
    const x = parseLength(node.attrs['x'], em, 0);
    const y = parseLength(node.attrs['y'], em, 0);

    const emit = (n: XmlNode, st: Style, cx: number, cy: number): { x: number; y: number } => {
      let px = cx;
      let py = cy;
      const nem = parseLength(st['font-size'], em, em);
      if (n.attrs['x'] !== undefined) px = parseLength(n.attrs['x'], nem, px);
      if (n.attrs['y'] !== undefined) py = parseLength(n.attrs['y'], nem, py);
      if (n.attrs['dx'] !== undefined) px += parseLength(n.attrs['dx'], nem, 0);
      if (n.attrs['dy'] !== undefined) py += parseLength(n.attrs['dy'], nem, 0);
      const direct = n.children.filter((c) => c.tag === '#text').map((c) => c.text ?? '').join('');
      if (direct.trim() !== '') {
        const c = parseColor(st['fill']) ?? color;
        const f = w.selectFont({
          height: Math.max(1, parseLength(st['font-size'], em, em) * scaleOf(m) * SCALE),
          bold: /^(bold|[6-9]00)$/.test((st['font-weight'] ?? '').trim()) || bold,
          italic: (st['font-style'] ?? '').trim() === 'italic' || italic,
          face: (st['font-family'] ?? face).split(',')[0]!.replace(/["']/g, '').trim(),
        });
        w.setTextColor(c);
        const a = (st['text-anchor'] ?? anchor).trim();
        w.setTextAlign((a === 'middle' ? TA.CENTER : a === 'end' ? TA.RIGHT : TA.LEFT) | TA.BASELINE);
        w.textOut(P(m, px, py), direct);
        w.deleteObject(f);
        counts.texts += 1;
      }
      for (const child of n.children) {
        if (child.tag === 'tspan') {
          const cs = computeStyle([...chainTo(n), child], rules);
          const r = emit(child, cs, px, py);
          px = r.x;
          py = r.y;
        }
      }
      return { x: px, y: py };
    };
    // 鎖は marker 経由でも呼ぶので、その場で作る
    const chainTo = (n: XmlNode): XmlNode[] => [root, n];
    emit(node, style, x, y);
  };

  function emitElement(node: XmlNode, style: Style, m: Matrix): void {
    if ((style['display'] ?? '') === 'none' || (style['visibility'] ?? '') === 'hidden') return;
    const em = parseLength(style['font-size'], 16, 16);
    const paint = paintOf(style, m);
    switch (node.tag) {
      case 'rect': {
        const x = parseLength(node.attrs['x'], em, 0);
        const y = parseLength(node.attrs['y'], em, 0);
        const rw = parseLength(node.attrs['width'], em, 0);
        const rh = parseLength(node.attrs['height'], em, 0);
        if (rw <= 0 || rh <= 0) return;
        const rx = parseLength(node.attrs['rx'], em, 0);
        const a = P(m, x, y);
        const b = P(m, x + rw, y + rh);
        drawShape(w, paint, (mode) => {
          void mode;
          if (rx > 0) w.roundRect(a.x, a.y, b.x - a.x, b.y - a.y, rx * scaleOf(m) * SCALE, rx * scaleOf(m) * SCALE);
          else w.rectangle(a.x, a.y, b.x - a.x, b.y - a.y);
        });
        counts.shapes += 1;
        return;
      }
      case 'circle':
      case 'ellipse': {
        const cx = parseLength(node.attrs['cx'], em, 0);
        const cy = parseLength(node.attrs['cy'], em, 0);
        const rx = parseLength(node.attrs['r'] ?? node.attrs['rx'], em, 0);
        const ry = parseLength(node.attrs['r'] ?? node.attrs['ry'], em, rx);
        if (rx <= 0 || ry <= 0) return;
        const c = P(m, cx, cy);
        drawShape(w, paint, () => w.ellipse(c.x, c.y, rx * scaleOf(m) * SCALE, ry * scaleOf(m) * SCALE));
        counts.shapes += 1;
        return;
      }
      case 'line': {
        const pts = [
          P(m, parseLength(node.attrs['x1'], em, 0), parseLength(node.attrs['y1'], em, 0)),
          P(m, parseLength(node.attrs['x2'], em, 0), parseLength(node.attrs['y2'], em, 0)),
        ];
        drawShape(w, { ...paint, fill: null }, () => w.polyline(pts));
        counts.shapes += 1;
        return;
      }
      case 'polygon':
      case 'polyline': {
        const nums = (node.attrs['points'] ?? '')
          .trim()
          .split(/[\s,]+/)
          .map(Number)
          .filter((n) => Number.isFinite(n));
        const pts: Point[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push(P(m, nums[i]!, nums[i + 1]!));
        if (pts.length < 2) return;
        drawShape(w, node.tag === 'polyline' ? { ...paint, fill: null } : paint, () =>
          node.tag === 'polygon' ? w.polygon(pts) : w.polyline(pts),
        );
        counts.shapes += 1;
        return;
      }
      case 'path':
        drawPath(node, style, m);
        return;
      case 'text':
        drawText(node, style, m);
        return;
      default:
        return;
    }
  }

  const SKIP = new Set(['defs', 'style', 'marker', 'filter', 'linearGradient', 'radialGradient', 'clipPath', 'title', 'desc']);

  (function visit(node: XmlNode, chain: XmlNode[], m: Matrix): void {
    if (SKIP.has(node.tag)) return;
    const here = [...chain, node];
    const local = multiply(m, parseTransform(node.attrs['transform']));
    if (node.tag !== 'svg' && node.tag !== 'g' && node.tag !== '#text') {
      emitElement(node, computeStyle(here, rules), local);
      return;
    }
    for (const child of node.children) visit(child, here, local);
  })(root, [], base);

  if (counts.shapes === 0 && counts.texts === 0) throw new Error('SVG から図形を 1 つも起こせませんでした');
  return { bytes: w.finish(), counts, widthPx: width, heightPx: height };
}
