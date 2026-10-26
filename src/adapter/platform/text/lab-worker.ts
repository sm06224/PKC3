/**
 * テキスト整形の置換ワーカーの**配線だけ**(#1233)。🔴 中身は `features/markdown/lab-regex.ts` の `applyLabRegex`。
 * ⚠ この中で固まったら、メイン側が時間切れで `terminate()` する(`lab-client.ts`)。
 */
import { applyLabRegex, type LabRegex } from '@features/markdown/lab-regex';

interface Incoming {
  id: number;
  payload: { text: string; regex: LabRegex };
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  try {
    ctx.postMessage({ id, ok: true, result: applyLabRegex(payload.text, payload.regex) });
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: String(e) });
  }
};
