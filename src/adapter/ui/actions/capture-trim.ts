/**
 * 🔴 **録った音の前後を削る段取り**(#683 段②a。user 裁定 2026-09-14)。
 *
 * > 録った音の前後を削ったら、**元と同じ形(opus)で保存する**。
 * > 切り出した結果は**新しい添付として 1 つ増え**、元のものは残る。
 *
 * 聞きながら「ここから」「ここまで」を押す → 「切り出す」→ **一覧に 1 件増える**。
 *
 * ## 🔑 ここが持っている判断(`webm-opus.ts` は「切るだけ」)
 *
 * - **元を上書きしない**(裁定)── 作るのは新しい添付だけ
 * - 🔴 **黙って終わらない** ── 切り出せない形・中身が消えている・添付にできない、
 *   どれも**理由を出す**(押したのに無言、を作らない)
 * - **2 本同時に走らせない** ── 12 時間の録音を 2 本ほどくと箱が詰まる
 *
 * ⚠ **取り込み口は `attachOne` の 1 本**(`attach` として注入する)── 2 つ目を作らない。
 * ⚠ **判定を `main.ts` へ出さない**(CLAUDE.md §2:あちらはどの test からも実行されない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { TRIM_REFUSAL_TEXT } from '@features/audio/webm-opus';
import { trimmedCaptureName } from '@features/audio/trim-text';
import { elapsedText } from '@features/elapsed-text';
import type { AudioTrimResult } from '@adapter/platform/audio/audio-codec';
import type { AttachItem, AttachedOne } from './attach';

export interface CaptureTrimDeps {
  readonly dispatcher: Dispatcher;
  /** 元の bytes を読む口。⚠ `null` = 中身がもう無い。 */
  readonly readBlob: (assetKey: string) => Promise<Blob | null>;
  /** 切る口(ワーカー)。⚠ **断る理由は値で返る**(例外にしない)。 */
  readonly trim: (blob: Blob, startMs: number, endMs: number) => Promise<AudioTrimResult>;
  /** bytes を添付にする口。⚠ **`attachOne` を通す**(2 つ目の取込口を作らない)。 */
  readonly attach: (item: AttachItem) => Promise<AttachedOne | null>;
  /** 一時の知らせ(エラーの行とは別)。 */
  readonly notify: (text: string) => void;
}

export interface CaptureTrimmer {
  /** 範囲を切り出して、新しい添付にする。 */
  run(lid: string, startMs: number, endMs: number): Promise<void>;
  /** いま走っているか(描画が「切り出しています…」を出すための観測点)。 */
  readonly busy: boolean;
}

export function createCaptureTrimmer(deps: CaptureTrimDeps): CaptureTrimmer {
  let running = false;
  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });

  return {
    get busy(): boolean {
      return running;
    },
    async run(lid: string, startMs: number, endMs: number): Promise<void> {
      // ⚠ 2 本目は**断る**(黙って無視しない ── 押したのに何も起きないのと同じになる)
      if (running) {
        fail('いま別の切り出しをしています。終わるまで待ってください。');
        return;
      }
      const items = deps.dispatcher.getState().captureItems ?? [];
      const item = items.find((i) => i.lid === lid);
      if (item === undefined || item.assetKey === null) {
        fail('この録音が見つかりませんでした。');
        return;
      }
      if (!(endMs > startMs)) {
        fail('切り出す範囲を「ここから」「ここまで」で決めてください。');
        return;
      }
      running = true;
      deps.notify('切り出しています…');
      try {
        const blob = await deps.readBlob(item.assetKey);
        if (blob === null) {
          fail('この録音の中身が見つかりませんでした。');
          return;
        }
        const cut = await deps.trim(blob, startMs, endMs);
        if (!cut.ok) {
          fail(TRIM_REFUSAL_TEXT[cut.reason]);
          return;
        }
        const name = trimmedCaptureName(item.name, startMs, endMs);
        const attached = await deps.attach({
          name,
          // 🔑 **元と同じ形**(裁定)── 入れ物も codec も変えないので mime も変えない
          type: item.mime,
          size: cut.bytes.byteLength,
          blob: new Blob([cut.bytes], { type: item.mime }),
        });
        if (attached === null) {
          fail('切り出したものを保存できませんでした。');
          return;
        }
        // 🔑 印は消す ── 同じ範囲をもう一度押して**同じものを 2 つ**作らせない
        deps.dispatcher.dispatch({ type: 'CLEAR_CAPTURE_TRIM' });
        deps.notify(`切り出しました:${name}(${elapsedText(cut.durationMs)})`);
      } catch (e: unknown) {
        fail(`切り出せませんでした(${String(e)})`);
      } finally {
        // ⚠ **必ず解く** ── 解かないと、1 度失敗しただけで以後ずっと断るようになる
        running = false;
      }
    },
  };
}
