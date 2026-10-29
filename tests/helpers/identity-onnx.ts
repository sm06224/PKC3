/**
 * 🔴 **恒等写像の ONNX モデルを手で組む**(音源分離 #674 / #949 の test / smoke の fixture)。
 *
 * 本物の重み(約 66MB)は test に持ち込まない・取りに行かない。代わりに `Identity` 1 個だけのグラフを protobuf で組み、
 * **本物の ONNX Runtime(wasm)でセッションを作って走らせる**: 重みが無くても、読み込み・入出力の形の検査・
 * 推論の呼び出し・前後の STFT が**実物の ORT を通って**つながることを確かめられる。
 * `padBytes` を渡すと、使わない初期値(zeros)で大きさを水増しする(取得側の「小さすぎる」門を通すため)。
 * 水増しの zeros はファイルの**最後**に置く(protobuf はフィールドの順を問わないので、配列を複製せず確保済みの 0 のままにできる)。
 */

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);
const lenField = (field: number, body: ArrayLike<number>): number[] => [...tag(field, 2), ...varint(body.length), ...Array.from(body)];
const strField = (field: number, s: string): number[] => lenField(field, Array.from(new TextEncoder().encode(s)));
const intField = (field: number, n: number): number[] => [...tag(field, 0), ...varint(n)];

function valueInfo(name: string, dims: readonly number[]): number[] {
  const shape = dims.flatMap((d) => lenField(1, intField(1, d)));
  const tensorType = [...intField(1, 1 /* FLOAT */), ...lenField(2, shape)];
  return [...strField(1, name), ...lenField(2, lenField(1, tensorType))];
}

/** @param dims 入出力の形 @param padBytes 使わない初期値で水増しする大きさ(byte) */
export function buildIdentityOnnx(dims: readonly number[], padBytes = 0): Uint8Array {
  const node = [...strField(1, 'x'), ...strField(2, 'y'), ...strField(3, 'id'), ...strField(4, 'Identity')];
  const graphHead = [
    ...lenField(1, node),
    ...strField(2, 'identity'),
    ...lenField(11, valueInfo('x', dims)),
    ...lenField(12, valueInfo('y', dims)),
  ];
  const opset = [...strField(1, ''), ...intField(2, 13)];
  const modelHead = [...intField(1, 8 /* ir_version */), ...strField(2, 'pkc3-test'), ...lenField(8, opset)];
  if (padBytes === 0) return Uint8Array.from([...modelHead, ...lenField(7, graphHead)]);

  // TensorProto: dims(1)、data_type(2)= UINT8(2)、name(8)、raw_data(9)= zeros(最後に置く)
  const tensorHead = [...intField(1, padBytes), ...intField(2, 2), ...strField(8, 'pad'), ...tag(9, 2), ...varint(padBytes)];
  const initializer = [...tag(5, 2), ...varint(tensorHead.length + padBytes), ...tensorHead];
  const graphBefore = [...graphHead, ...initializer];
  const graphLen = graphBefore.length + padBytes;
  const head = [...modelHead, ...tag(7, 2), ...varint(graphLen), ...graphBefore];
  const out = new Uint8Array(head.length + padBytes); // 末尾の padBytes は 0 のまま
  out.set(head, 0);
  return out;
}
