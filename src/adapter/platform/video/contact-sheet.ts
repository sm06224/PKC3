/**
 * 🔴 **コンタクトシートを作る**(#952 A5)── 場面ごとの静止画と文字起こしを 1 枚の PNG にする。ワーカーの中で動く。
 *
 * - 場面の頭は `scenesVideo` と同じ(映像フレームの大きさ)。見つからない動画は長さを均等に割った時刻を使う
 * - 絵は WebCodecs(VP8)で**場面の手前のキーフレームから場面の 1 枚まで**だけ復号し、受け取ったらすぐシートへ描いて
 *   `close()` する(同時に生きる `VideoFrame` は 1 枚。🔑 ゼロコピー・即破棄)
 * - 描くのは `OffscreenCanvas`。PNG にして返す(「描いたら焼く」── 画面に置くのは PNG の `<img>` 1 枚)
 * - 🔴 WebCodecs / OffscreenCanvas が無い環境では**作らず、理由を返す**(別の道で偽の絵を作らない)
 *
 * 配置の計算は `features/capture/contact-sheet-layout.ts`(pure)。ここは復号と描画の口だけ。
 * ⚠ 道具(`CodecApi` / `DrawApi`)は差し替えられる形にして、unit が本物の意味論を真似た偽物で通せる。
 */
import { elapsedText } from '@features/elapsed-text';
import { sceneStartsFromFrames } from '@features/capture/chapters';
import {
  evenStarts,
  layoutSheet,
  sceneText,
  selectScenes,
  wrapByWidth,
  SHEET,
  type TimedLine,
} from '@features/capture/contact-sheet-layout';
import { scanWebmVideo, type VideoBlock, type VideoTrimRefusal } from '@features/video/webm-vp8';
import { blobSource, nativeCodecApi, STALL_MS, type CodecApi, type FrameLike } from './video-codec';

export interface DrawSheet {
  fill(color: string, x: number, y: number, w: number, h: number): void;
  /** 復号したフレームを (x, y, w, h) に描く。⚠ 呼び側が `close()` する。 */
  frame(f: FrameLike, x: number, y: number, w: number, h: number): void;
  text(s: string, x: number, y: number, color: string, px: number): void;
  measure(s: string, px: number): number;
  toPng(): Promise<Blob>;
}

export interface DrawApi {
  create(width: number, height: number): DrawSheet;
}

/** この場所(ワーカー)で絵を描く道具。無ければ `null`。 */
export function nativeDrawApi(): DrawApi | null {
  const g = globalThis as unknown as { OffscreenCanvas?: typeof OffscreenCanvas };
  if (typeof g.OffscreenCanvas !== 'function') return null;
  return {
    create: (width, height) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('絵を描く場所を作れませんでした');
      ctx.textBaseline = 'top';
      const font = (px: number): string => `${String(px)}px sans-serif`;
      return {
        fill: (color, x, y, w, h) => {
          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, h);
        },
        frame: (f, x, y, w, h) => ctx.drawImage(f as unknown as VideoFrame, x, y, w, h),
        text: (s, x, y, color, px) => {
          ctx.font = font(px);
          ctx.fillStyle = color;
          ctx.fillText(s, x, y);
        },
        measure: (s, px) => {
          ctx.font = font(px);
          return ctx.measureText(s).width;
        },
        toPng: () => canvas.convertToBlob({ type: 'image/png' }),
      };
    },
  };
}

export interface ContactSheetJob {
  readonly blob: Blob;
  /** 文字起こしの行(時刻つき)。無ければ空。 */
  readonly lines: readonly TimedLine[];
  /** シートの見出し(元の名前)。 */
  readonly title: string;
}

export type ContactSheetResult =
  | { readonly ok: true; readonly blob: Blob; readonly scenes: number; readonly withText: number }
  | { readonly ok: false; readonly reason: VideoTrimRefusal | 'no-codec' | 'decode-failed' };

const INK = '#222';
const SUB = '#555';
const BG = '#fff';
const PLACEHOLDER = '#ddd';

/** 均等に割るときの枚数。 */
const EVEN_SCENES = 6;

export async function contactSheetVideo(
  job: ContactSheetJob,
  api: CodecApi | null = nativeCodecApi(),
  draw: DrawApi | null = nativeDrawApi(),
): Promise<ContactSheetResult> {
  if (api === null || draw === null) return { ok: false, reason: 'no-codec' };
  const src = blobSource(job.blob);
  const scanned = await scanWebmVideo(src, Number.POSITIVE_INFINITY);
  if (!scanned.ok) return scanned;
  const { scan } = scanned;
  const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
  if (video.length === 0) return { ok: false, reason: 'no-video' };

  let starts = sceneStartsFromFrames(video.map((b) => ({ ms: b.ms, bytes: b.dataEnd - b.dataStart, key: b.key })));
  if (starts.length < 2) starts = evenStarts(scan.sourceEndMs, EVEN_SCENES);
  starts = selectScenes(starts);

  const layout = layoutSheet(starts.length, scan.width / Math.max(1, scan.height));
  const sheet = draw.create(layout.width, layout.height);
  sheet.fill(BG, 0, 0, layout.width, layout.height);
  sheet.text(job.title, SHEET.margin, SHEET.margin, INK, SHEET.fontPx + 2);

  // 絵を取る位置:場面の頭の時刻以下で最後の映像ブロック。そこへ届くキーフレームから復号する
  const targets = starts.map((t) => {
    let idx = 0;
    for (let i = 0; i < video.length; i += 1) {
      if (video[i]!.ms <= t) idx = i;
      else break;
    }
    let keyIdx = idx;
    while (keyIdx > 0 && !video[keyIdx]!.key) keyIdx -= 1;
    return { idx, keyIdx };
  });

  let error: unknown = null;
  let want: { us: number; cell: number } | null = null;
  let drawn = 0;
  const dec = api.createDecoder({
    output: (f) => {
      try {
        if (want !== null && f.timestamp === want.us) {
          const c = layout.cells[want.cell]!;
          sheet.frame(f, c.x, c.y, c.w, c.h);
          drawn += 1;
        }
      } catch (e) {
        error = e;
      } finally {
        f.close(); // 🔑 受け取ったらすぐ破棄(同時に生きるのは 1 枚)
      }
    },
    error: (e) => {
      error = e;
    },
  });
  try {
    dec.configure({ codec: 'vp8', codedWidth: scan.width, codedHeight: scan.height });
    const withStall = async (p: Promise<void>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('復号が止まった')), STALL_MS);
      });
      try {
        await Promise.race([p, stalled]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    for (let i = 0; i < starts.length; i += 1) {
      const cell = layout.cells[i]!;
      sheet.fill(PLACEHOLDER, cell.x, cell.y, cell.w, cell.h);
      const { idx, keyIdx } = targets[i]!;
      const target = video[idx]!;
      want = { us: target.ms * 1000, cell: i };
      const feed = async (): Promise<void> => {
        for (let k = keyIdx; k <= idx; k += 1) {
          const b: VideoBlock = video[k]!;
          const data = await src.read(b.dataStart, b.dataEnd);
          if (error !== null) return;
          dec.decode({ type: b.key ? 'key' : 'delta', timestamp: b.ms * 1000, data });
        }
        await dec.flush();
      };
      await withStall(feed());
      if (error !== null) throw error instanceof Error ? error : new Error(String(error));
      // 欄:時刻 + その場面の文字起こし
      sheet.text(elapsedText(starts[i]!), cell.captionX, cell.captionY, INK, SHEET.fontPx);
      const txt = sceneText(starts, i, job.lines);
      if (txt !== '') {
        const wrapped = wrapByWidth(txt, cell.w, (s) => sheet.measure(s, SHEET.fontPx), SHEET.captionLines - 1);
        wrapped.forEach((l, n) => sheet.text(l, cell.captionX, cell.captionY + SHEET.lineH * (n + 1), SUB, SHEET.fontPx));
      }
    }
  } catch {
    return { ok: false, reason: 'decode-failed' };
  } finally {
    try {
      dec.close();
    } catch {
      /* 閉じられないなら諦める */
    }
  }
  if (drawn === 0) return { ok: false, reason: 'decode-failed' };
  const png = await sheet.toPng();
  const withText = starts.filter((_, i) => sceneText(starts, i, job.lines) !== '').length;
  return { ok: true, blob: png, scenes: starts.length, withText };
}
