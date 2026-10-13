/**
 * 🔴 **画像に描き込む段取り**(#683 段③。裁定は #1163 のコメント = Gemini への委任)。
 *
 * > 描いたものは**1 枚の新しい画像に焼いて**、新しい添付として保存する。
 * > 元の画像は触らない。やり直しの履歴は持たない。
 *
 * 別ウィンドウで描き、「新しい画像として保存」を押したときにここの `save` が走る。
 * 作りは `capture-trim.ts`(録音の切り出し)・`save-edited.ts`(PDF の保存)に揃えた:
 *
 * - **元を上書きしない** ── 作るのは新しい添付だけ。取り込み口は `attachOne` の 1 本
 * - 🔴 **元の画像と同じフォルダへ入れる**(保存した物が元の隣に見えるように。#275 段②-1b と同じ
 *   `place` ── 2 本目の置き場の規則を作らない)。⚠ 読んでいるノートも選択も動かさない
 *   (`keepSelection`。#300)
 * - 🔴 **黙って終わらない・描いた線を失わせない** ── 本文に書けない間は
 *   **窓を開いたまま**理由を窓の中に出す。もう一度押せば同じものが保存できる
 * - **同時に 1 本** ── 保存の最中にもう 1 回押されても 2 つ作らない
 * - **同じ画像の窓は 1 枚** ── 開いている間に押し直したら、開き直さず手前に出す
 * - 🔴 **窓は押した瞬間(同期)に開く**。画像を読むのを待ってから開くと、Safari / Firefox が
 *   ポップアップを止める
 *
 * ⚠ **判定を `main.ts` へ出さない**(CLAUDE.md §2:あちらはどの test からも実行されない)。
 */
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import type {
  ImageDrawSaveResult,
  ImageDrawWindow,
  ImageDrawWindowDeps,
} from '@adapter/platform/image-draw-window';
import { canDrawOnImage, drawnImageName } from '@features/asset/image-draw';
import type { AttachItem, AttachedOne } from './attach';
import { canWriteBody } from './writable-queue';

/**
 * 本文に書けないときの断り文。
 * ⚠ `canWriteBody` が断るのは「編集中」だけではない(読む画面でない間 / 別の書込の最中)──
 *   だから編集だけを言い切らない。
 */
export const IMAGE_DRAW_BUSY_TEXT =
  'いまは保存できません(ノートを編集している間や、別の保存の最中です)。編集を終えるか少し待ってから、もう一度「新しい画像として保存」を押してください(描いた線は残しています)。';

/** 窓を開けなかったとき。⚠ 許可の出し方まで言う(他の窓の断り文と同じ言い方)。 */
export const IMAGE_DRAW_POPUP_BLOCKED_TEXT =
  '別のウィンドウを開けませんでした。ブラウザのポップアップの許可を出してから、もう一度押してください';

export interface ImageDrawDeps {
  readonly dispatcher: Dispatcher;
  /** 元の bytes を読む口。⚠ `null` = 中身がもう無い。 */
  readonly readBlob: (assetKey: string) => Promise<Blob | null>;
  /** 添付(ノート)の置き場のフォルダ。ルートなら `null`。 */
  readonly parentOf: (lid: string) => string | null;
  /** bytes を添付にする口。⚠ **`attachOne` を通す**(2 つ目の取込口を作らない)。 */
  readonly attach: (
    item: AttachItem,
    place: { readonly parentLid: string | null; readonly keepSelection: boolean },
  ) => Promise<AttachedOne | null>;
  /** 描き込みの窓を**同期で**開く口。開けなければ `null`。 */
  readonly openWindow: (deps: ImageDrawWindowDeps) => ImageDrawWindow | null;
  /** 状態の知らせ(ステータスバー)。 */
  readonly notify: (text: string) => void;
}

export interface ImageDrawer {
  /** @param lid 押した添付のノート(置き場のフォルダを引く起点)。無ければルート。 */
  run(assetKey: string, name: string, mime: string, lid?: string): Promise<void>;
}

export function createImageDrawer(deps: ImageDrawDeps): ImageDrawer {
  let saving = false;
  /** 開いている窓(添付ごとに 1 枚)。 */
  const windows = new Map<string, ImageDrawWindow>();
  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });

  return {
    async run(assetKey: string, name: string, mime: string, lid?: string): Promise<void> {
      // 開けない種類は、窓を開く前に断る
      if (!canDrawOnImage(mime)) {
        fail(`この種類の画像には描き込めません(対応は PNG・JPEG・WebP・BMP です): ${name}`);
        return;
      }
      // 開いている窓があれば、開き直さず手前に出す(2 枚目の復号も待ちも作らない)
      const existing = windows.get(assetKey);
      if (existing !== undefined && !existing.closed) {
        existing.focus();
        return;
      }
      // ⚠ 押した瞬間のうちに開く(`await` の前)── 後ろへ回すとポップアップが止められる
      const win = deps.openWindow({
        title: name,
        windowName: `pkc3-draw-${assetKey}`,
        onClosed: () => {
          if (windows.get(assetKey) === win) windows.delete(assetKey);
        },
      });
      if (win === null) {
        fail(IMAGE_DRAW_POPUP_BLOCKED_TEXT);
        return;
      }
      windows.set(assetKey, win);
      // 置き場は押した瞬間に採る(読んでいる間に選択が動いても、元の隣へ入る)
      const parentLid = lid === undefined ? null : deps.parentOf(lid);
      let blob: Blob | null;
      try {
        blob = await deps.readBlob(assetKey);
      } catch (e) {
        win.fail(`画像を読み込めませんでした(${errorText(e)})`);
        return;
      }
      if (blob === null) {
        win.fail('画像の中身が見つかりませんでした');
        return;
      }
      await win.start(blob, async (png: Blob): Promise<ImageDrawSaveResult> => {
        if (saving) return { ok: false, message: 'いま保存しています。終わるまで待ってください。' };
        if (!canWriteBody(deps.dispatcher)) return { ok: false, message: IMAGE_DRAW_BUSY_TEXT };
        saving = true;
        try {
          const newName = drawnImageName(name);
          // attachOne が理由を先に OP_FAILED で出すので、撃つ前の値を控えて取り違えない
          const errorBefore = deps.dispatcher.getState().error;
          const attached = await deps.attach(
            { name: newName, type: 'image/png', size: png.size, blob: png },
            // 読んでいるノートも選択も動かさない。置くのは元と同じフォルダ
            { parentLid, keepSelection: true },
          );
          if (attached === null) {
            const now = deps.dispatcher.getState().error;
            return {
              ok: false,
              message: now !== null && now !== errorBefore ? now : '保存できませんでした。',
            };
          }
          deps.notify(`描き込んだ画像を保存しました:「${newName}」`);
          return { ok: true };
        } finally {
          saving = false;
        }
      });
    },
  };
}
