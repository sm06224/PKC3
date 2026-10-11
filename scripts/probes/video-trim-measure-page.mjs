/* eslint-disable no-undef */
/**
 * 動画の切り出し(#683 段②b)の実測 probe の「ページの中で動く側」。
 * 各関数は `Function.prototype.toString()` でページへ送る ── ⚠ 外側の変数を参照しない(自己完結)。
 * 親: `scripts/probes/video-trim-measure.mjs`
 */

/**
 * 合成の絵(静止した細かい絵を横へパンさせる = 動き補償が効く内容)と、左上に 12bit のフレーム番号の白黒ブロック。
 * `draw(ctx, t, frameNo, flash)`: t は秒、flash が真なら画面全体を白にする(番号は白の上にも描く)。
 */
export function makeScene(width, height, canvasFactory) {
  const tex = canvasFactory(width * 2, height);
  const tx = tex.getContext('2d');
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  tx.fillStyle = '#3a4a5a';
  tx.fillRect(0, 0, tex.width, tex.height);
  const unit = Math.max(1, Math.round(height / 540));
  for (let i = 0; i < 1800; i += 1) {
    tx.fillStyle = 'hsl(' + Math.round(rnd() * 360) + ',' + Math.round(30 + rnd() * 60) + '%,' + Math.round(20 + rnd() * 60) + '%)';
    const w = (4 + rnd() * 120) * unit;
    const h = (4 + rnd() * 60) * unit;
    tx.fillRect(rnd() * tex.width, rnd() * tex.height, w, h);
  }
  tx.strokeStyle = 'rgba(255,255,255,0.35)';
  tx.lineWidth = unit;
  for (let x = 0; x < tex.width; x += 48 * unit) {
    tx.beginPath();
    tx.moveTo(x, 0);
    tx.lineTo(x, tex.height);
    tx.stroke();
  }
  for (let i = 0; i < 400; i += 1) {
    tx.fillStyle = 'rgba(255,255,255,0.8)';
    tx.font = String(12 * unit) + 'px sans-serif';
    tx.fillText(String(Math.floor(rnd() * 99999)), rnd() * tex.width, rnd() * tex.height);
  }
  const draw = (ctx, t, frameNo, flash) => {
    const pan = (t * 90 * unit) % width;
    ctx.drawImage(tex, pan, 0, width, height, 0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect((t * 300 * unit) % (width - 200 * unit), height * 0.6, 200 * unit, 80 * unit);
    if (flash) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    const n = frameNo & 0xfff;
    for (let b = 0; b < 12; b += 1) {
      ctx.fillStyle = (n >> (11 - b)) & 1 ? '#fff' : '#000';
      ctx.fillRect(b * 40, 0, 40, 40);
    }
  };
  return { draw };
}

/**
 * 合成の webm を `MediaRecorder` で録る(実時間。アプリが取り込む形そのもの: 音つき・`BlockGroup`)。
 * `pairs`(秒)ごとに、音の 80ms のビープと、画面全体の白い点滅(0.4 秒)を同じ基準時計(AudioContext)で出す。
 */
export async function genSource(key, width, height, seconds, pairs, mrOpts) {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx2d = cv.getContext('2d');
  const scene = window.__p.makeScene(width, height, (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });
  const ac = new AudioContext();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const vs = cv.captureStream(30);
  const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = 'video/webm;codecs=vp8,opus';
  if (!MediaRecorder.isTypeSupported(mime)) return { error: 'MediaRecorder が ' + mime + ' を持たない' };
  const rec = new MediaRecorder(stream, { mimeType: mime, ...mrOpts });
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise((res) => {
    rec.onstop = res;
  });
  const t0 = ac.currentTime + 0.3;
  for (const p of pairs) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = 1000;
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0 + p - 0.001);
    g.gain.setValueAtTime(0.6, t0 + p);
    g.gain.setValueAtTime(0, t0 + p + 0.08);
    o.connect(g);
    g.connect(dest);
    o.start(t0 + p - 0.01);
    o.stop(t0 + p + 0.2);
  }
  let frameNo = 0;
  let drawn = 0;
  let rafs = 0;
  const startPerf = performance.now();
  rec.start(1000);
  await new Promise((resolve) => {
    const draw = () => {
      const t = ac.currentTime - t0;
      if (t > seconds) {
        resolve();
        return;
      }
      // 30Hz で描く(60Hz で描くと、描画が録画の符号化と CPU を奪い合って録れるフレームが減る)
      if (((rafs += 1) & 1) === 0) {
        frameNo += 1;
        scene.draw(ctx2d, t, frameNo, pairs.some((p) => t >= p && t < p + 0.4));
        drawn += 1;
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
  rec.stop();
  await stopped;
  for (const tr of stream.getTracks()) tr.stop();
  await ac.close();
  const blob = new Blob(chunks, { type: 'video/webm' });
  window.__src = window.__src || {};
  window.__src[key] = blob;
  return { bytes: blob.size, drawn, drawFps: Math.round(((drawn * 1000) / (performance.now() - startPerf)) * 10) / 10 };
}

/**
 * WebCodecs(VP8)で決まった fps の webm を作る(非実時間。音なし)。`MediaRecorder` は 4K を実時間で 5fps ほどしか
 * 録れない(この箱)ので、30fps の 4K を得るために使う。キーフレームは `keySec` ごと。
 * 容器: EBML ヘッダ + `Segment` + `Info` + `Tracks` + 1 秒ごとの `Cluster`(`SimpleBlock`)。
 */
export async function genSourceWc(key, width, height, seconds, fps, keySec, bitrate) {
  const cv = new OffscreenCanvas(width, height);
  const ctx = cv.getContext('2d');
  const scene = window.__p.makeScene(width, height, (w, h) => new OffscreenCanvas(w, h));
  const chunks = [];
  let err = null;
  const enc = new VideoEncoder({
    output: (c) => {
      const d = new Uint8Array(c.byteLength);
      c.copyTo(d);
      chunks.push({ key: c.type === 'key', ms: Math.round(c.timestamp / 1000), data: d });
    },
    error: (e) => {
      err = String(e);
    },
  });
  enc.configure({ codec: 'vp8', width, height, bitrate, framerate: fps, bitrateMode: 'variable' });
  const n = Math.round(seconds * fps);
  const t00 = performance.now();
  for (let i = 0; i < n; i += 1) {
    while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
    if (err) break;
    scene.draw(ctx, i / fps, i + 1, false);
    const f = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps) });
    enc.encode(f, { keyFrame: i % Math.round(keySec * fps) === 0 });
    f.close();
  }
  await enc.flush();
  enc.close();
  if (err) return { error: err };
  const genMs = performance.now() - t00;
  const u8 = (...a) => Uint8Array.from(a);
  const cat = (parts) => {
    let len = 0;
    for (const p of parts) len += p.length;
    const o = new Uint8Array(len);
    let at = 0;
    for (const p of parts) {
      o.set(p, at);
      at += p.length;
    }
    return o;
  };
  const size = (len) => u8(0x01, 0, 0, 0, (len / 16777216) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  const el = (id, payload) => cat([Uint8Array.from(id), size(payload.length), payload]);
  const uint = (v) => {
    const b = [];
    let x = v;
    do {
      b.unshift(x & 0xff);
      x = Math.floor(x / 256);
    } while (x > 0);
    return Uint8Array.from(b);
  };
  const str = (s2) => Uint8Array.from(s2, (c) => c.charCodeAt(0));
  const header = el([0x1a, 0x45, 0xdf, 0xa3], cat([
    el([0x42, 0x86], uint(1)), el([0x42, 0xf7], uint(1)), el([0x42, 0xf2], uint(4)), el([0x42, 0xf3], uint(8)),
    el([0x42, 0x82], str('webm')), el([0x42, 0x87], uint(4)), el([0x42, 0x85], uint(2)),
  ]));
  const info = el([0x15, 0x49, 0xa9, 0x66], cat([el([0x2a, 0xd7, 0xb1], uint(1000000)), el([0x4d, 0x80], str('probe')), el([0x57, 0x41], str('probe'))]));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], cat([
    el([0xd7], uint(1)), el([0x73, 0xc5], uint(1)), el([0x83], uint(1)), el([0x86], str('V_VP8')),
    el([0xe0], cat([el([0xb0], uint(width)), el([0xba], uint(height))])),
  ])));
  const clusters = [];
  let i0 = 0;
  while (i0 < chunks.length) {
    const baseMs = chunks[i0].ms;
    const parts = [el([0xe7], uint(baseMs))];
    let i1 = i0;
    while (i1 < chunks.length && chunks[i1].ms - baseMs < 1000) {
      const c = chunks[i1];
      const rel = c.ms - baseMs;
      parts.push(el([0xa3], cat([u8(0x81, (rel >> 8) & 0xff, rel & 0xff, c.key ? 0x80 : 0x00), c.data])));
      i1 += 1;
    }
    clusters.push(el([0x1f, 0x43, 0xb6, 0x75], cat(parts)));
    i0 = i1;
  }
  const body = cat([info, tracks, ...clusters]);
  const blob = new Blob([header, Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), body], { type: 'video/webm' });
  window.__src = window.__src || {};
  window.__src[key] = blob;
  return { bytes: blob.size, frames: chunks.length, keys: chunks.filter((c) => c.key).length, genMs: Math.round(genMs), actualBitrate: Math.round((blob.size * 8) / seconds) };
}

/**
 * `<video>` を実時間で再生し、(a) 映像の白い点滅の立ち上がり、(b) 音のビープの立ち上がりを、同じ基準時計(AudioContext)で採る。
 * 返す時刻は AudioContext の秒。音と映像の差の「向きと大きさ」だけを見る(出力の遅れは元と出力で同じなので相殺する)。
 * 解像度は映像のフレーム間隔と rVFC の表示時刻の精度(おおよそ 1 フレーム)で決まる。
 */
export async function measureSync(blobKey, which, rate) {
  const blob = which === 'src' ? window.__src[blobKey] : window.__out[blobKey];
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.src = url;
  v.playbackRate = rate || 1;
  v.preload = 'auto';
  document.body.appendChild(v);
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('video error'));
  });
  const ac = new AudioContext();
  await ac.resume();
  const src = ac.createMediaElementSource(v);
  const code =
    'class D extends AudioWorkletProcessor{constructor(){super();this.armed=true;this.quiet=0;}' +
    'process(i){const c=i[0][0];if(!c)return true;let m=0;for(let k=0;k<c.length;k++){const a=Math.abs(c[k]);if(a>m)m=a;}' +
    'if(this.armed&&m>0.15){let at=0;for(let k=0;k<c.length;k++){if(Math.abs(c[k])>0.15){at=k;break;}}' +
    'this.port.postMessage({t:currentTime+at/sampleRate});this.armed=false;this.quiet=0;}' +
    'else if(!this.armed){if(m<0.02){this.quiet+=c.length/sampleRate;if(this.quiet>0.4)this.armed=true;}else this.quiet=0;}' +
    'return true;}}registerProcessor("d",D);';
  const wurl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  await ac.audioWorklet.addModule(wurl);
  const node = new AudioWorkletNode(ac, 'd');
  const sink = ac.createGain();
  sink.gain.value = 0;
  src.connect(node);
  node.connect(sink);
  sink.connect(ac.destination);
  const beeps = [];
  node.port.onmessage = (e) => beeps.push(e.data.t);
  const flashes = [];
  const cvs = document.createElement('canvas');
  cvs.width = 32;
  cvs.height = 18;
  const cx = cvs.getContext('2d', { willReadFrequently: true });
  let inFlash = false;
  let frames = 0;
  const firstMedia = { t: null };
  const lastMedia = { t: null };
  const onFrame = (now, md) => {
    frames += 1;
    if (firstMedia.t === null) firstMedia.t = md.mediaTime;
    lastMedia.t = md.mediaTime;
    cx.drawImage(v, 0, 0, 32, 18);
    const d = cx.getImageData(0, 0, 32, 18).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i];
    const mean = s / (d.length / 4);
    const hot = mean > 200;
    if (hot && !inFlash) {
      const ts = ac.getOutputTimestamp();
      const display = md.expectedDisplayTime || now;
      flashes.push({ t: ts.contextTime + (display - ts.performanceTime) / 1000, media: md.mediaTime });
    }
    inFlash = hot;
    if (!v.ended) v.requestVideoFrameCallback(onFrame);
  };
  v.requestVideoFrameCallback(onFrame);
  const ended = new Promise((res) => {
    v.onended = res;
  });
  await v.play();
  await ended;
  await new Promise((r) => setTimeout(r, 300));
  const duration = v.duration;
  v.remove();
  await ac.close();
  URL.revokeObjectURL(url);
  URL.revokeObjectURL(wurl);
  return { beeps, flashes, frames, duration, firstMedia: firstMedia.t, lastMedia: lastMedia.t };
}

/**
 * 出力と元を再生して、同じ番号のフレームを対にして PSNR / SSIM(輝度)を出す。
 * targets = 出力の時刻(秒)の一覧。各 target で「その時刻以上で最初に出たフレーム」を採る。
 */
export async function measureQuality(blobKey, srcKey, startMs, targets, rate) {
  const readIndex = (cx) => {
    const d = cx.getImageData(0, 0, 480, 40).data;
    let n = 0;
    for (let b = 0; b < 12; b += 1) {
      const px = (20 * 480 + b * 40 + 20) * 4;
      n = (n << 1) | (d[px] > 128 ? 1 : 0);
    }
    return n;
  };
  const grab = async (blob, wanted, fromSec, toSec) => {
    // wanted: null なら targets を使う(出力側)。Set なら番号で採る(元側)
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.playbackRate = rate || 0.5;
    v.preload = 'auto';
    document.body.appendChild(v);
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('video error'));
    });
    const small = document.createElement('canvas');
    small.width = 480;
    small.height = 40;
    const sx = small.getContext('2d', { willReadFrequently: true });
    const full = document.createElement('canvas');
    full.width = v.videoWidth;
    full.height = v.videoHeight;
    const fx = full.getContext('2d', { willReadFrequently: true });
    const got = [];
    const pending = wanted === null ? targets.slice() : null;
    const need = wanted === null ? null : new Set(wanted);
    const lumaOf = () => {
      const d = fx.getImageData(0, 0, full.width, full.height).data;
      const y = new Float32Array(full.width * full.height);
      for (let i = 0, j = 0; i < d.length; i += 4, j += 1) y[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return y;
    };
    let doneResolve;
    const done = new Promise((res) => {
      doneResolve = res;
    });
    const cb = (now, md) => {
      sx.drawImage(v, 0, 0, 480, 40, 0, 0, 480, 40);
      const idx = readIndex(sx);
      if (wanted === null) {
        if (pending.length > 0 && md.mediaTime >= pending[0]) {
          fx.drawImage(v, 0, 0);
          got.push({ target: pending.shift(), media: md.mediaTime, idx, y: lumaOf() });
        }
        if (pending.length === 0) {
          doneResolve();
          return;
        }
      } else {
        if (need.has(idx)) {
          fx.drawImage(v, 0, 0);
          got.push({ idx, media: md.mediaTime, y: lumaOf() });
          need.delete(idx);
        }
        if (need.size === 0 || md.mediaTime > toSec) {
          doneResolve();
          return;
        }
      }
      if (!v.ended) v.requestVideoFrameCallback(cb);
      else doneResolve();
    };
    v.currentTime = fromSec;
    await new Promise((r) => {
      v.onseeked = r;
    });
    v.requestVideoFrameCallback(cb);
    await v.play();
    v.onended = () => doneResolve();
    await done;
    v.pause();
    v.remove();
    URL.revokeObjectURL(url);
    return got;
  };
  const outGot = await grab(window.__out[blobKey], null, Math.max(0, targets[0] - 0.2), 0);
  const wanted = outGot.map((g) => g.idx);
  const startSec = startMs / 1000;
  const srcGot = await grab(window.__src[srcKey], wanted, Math.max(0, startSec + targets[0] - 0.3), startSec + targets[targets.length - 1] + 1.5);
  const psnr = (a, b) => {
    let se = 0;
    for (let i = 0; i < a.length; i += 1) {
      const d = a[i] - b[i];
      se += d * d;
    }
    const mse = se / a.length;
    return mse === 0 ? 100 : 10 * Math.log10((255 * 255) / mse);
  };
  const ssim = (a, b, w, h) => {
    const C1 = (0.01 * 255) ** 2;
    const C2 = (0.03 * 255) ** 2;
    let sum = 0;
    let n = 0;
    for (let by = 0; by + 8 <= h; by += 8) {
      for (let bx = 0; bx + 8 <= w; bx += 8) {
        let ma = 0;
        let mb = 0;
        for (let y = 0; y < 8; y += 1) {
          const o = (by + y) * w + bx;
          for (let x = 0; x < 8; x += 1) {
            ma += a[o + x];
            mb += b[o + x];
          }
        }
        ma /= 64;
        mb /= 64;
        let va = 0;
        let vb = 0;
        let cv = 0;
        for (let y = 0; y < 8; y += 1) {
          const o = (by + y) * w + bx;
          for (let x = 0; x < 8; x += 1) {
            const da = a[o + x] - ma;
            const db = b[o + x] - mb;
            va += da * da;
            vb += db * db;
            cv += da * db;
          }
        }
        va /= 63;
        vb /= 63;
        cv /= 63;
        sum += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
        n += 1;
      }
    }
    return sum / n;
  };
  const W = srcGot.length > 0 ? Math.round(Math.sqrt((outGot[0].y.length * 16) / 9)) : 0;
  const rows = [];
  for (const o of outGot) {
    const s = srcGot.find((g) => g.idx === o.idx);
    if (!s) {
      rows.push({ target: o.target, idx: o.idx, outMedia: o.media, missing: true });
      continue;
    }
    const w = W;
    const h = o.y.length / w;
    rows.push({ target: o.target, idx: o.idx, outMedia: o.media, srcMedia: s.media, psnr: psnr(o.y, s.y), ssim: ssim(o.y, s.y, w, h) });
  }
  // 隣り合うフレーム(番号の差が 1〜3)の平均絶対差: 継ぎ目で出力の動きが元と違うかを見る
  const mad = (a, b) => {
    let t = 0;
    for (let i = 0; i < a.length; i += 1) t += Math.abs(a[i] - b[i]);
    return t / a.length;
  };
  for (let i = 0; i + 1 < outGot.length; i += 1) {
    const d = (outGot[i + 1].idx - outGot[i].idx + 4096) % 4096;
    const sa = srcGot.find((g) => g.idx === outGot[i].idx);
    const sb = srcGot.find((g) => g.idx === outGot[i + 1].idx);
    if (d >= 1 && d <= 3 && sa && sb) {
      rows[i].madToNext = { idxStep: d, out: mad(outGot[i].y, outGot[i + 1].y), src: mad(sa.y, sb.y) };
    }
  }
  return rows;
}
