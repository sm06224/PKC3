/**
 * `hidden="until-found"`(と `beforematch`)に対応するブラウザかどうかを、happy-dom の文書に差し込む。
 * 🔑 描画器は `'onbeforematch' in document.documentElement` で対応を見分ける(左の一覧の窓。`filer.ts` の `wantedChunks`)。
 * happy-dom は対応しないので、窓の test は `true` にして対応ブラウザを、全部組む側の test は `false` で対応しないブラウザを再現する。
 */
export function supportUntilFound(on: boolean): void {
  const el = document.documentElement as unknown as Record<string, unknown>;
  if (on) Object.defineProperty(el, 'onbeforematch', { value: null, configurable: true, writable: true });
  else delete el['onbeforematch'];
}
