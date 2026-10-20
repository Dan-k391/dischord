/* Takes this app's own call audio back out of shared computer sound, for systems that cannot leave one program
   out of what they capture (Windows 10). Input 0 is the captured sound (stereo), input 1 the reference: exactly
   what the call is playing. Each channel runs a partitioned-block frequency-domain adaptive filter (PBFDAF): it
   learns how the reference reaches the capture (a fixed digital path: playback buffers, mixing, capture) and
   subtracts its estimate. 32 partitions of 256 samples cover about 170 ms of delay at 48 kHz. */
const B = 256, N = 512, P = 32;
const MU = 0.35 / P; // step size: converges in a few seconds of call audio, stays steady under other sound

// in-place radix-2 FFT on separate real / imaginary arrays (N = 512)
const LOG = Math.log2(N), REV = new Uint16Array(N), COS = new Float32Array(N / 2), SIN = new Float32Array(N / 2);
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); REV[i] = r; }
for (let i = 0; i < N / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / N); SIN[i] = -Math.sin(2 * Math.PI * i / N); }
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step], wi = inverse ? -SIN[k * step] : SIN[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

class Channel {
  constructor() {
    this.wr = Array.from({ length: P }, () => new Float32Array(N));
    this.wi = Array.from({ length: P }, () => new Float32Array(N));
    this.bad = 0;
  }
  reset() { for (let p = 0; p < P; p++) { this.wr[p].fill(0); this.wi[p].fill(0); } this.bad = 0; }
}

class EchoCancel extends AudioWorkletProcessor {
  constructor() {
    super();
    this.near = [new Float32Array(B), new Float32Array(B)]; this.ref = new Float32Array(B); this.fill = 0;
    this.prevRef = new Float32Array(B);
    this.xr = Array.from({ length: P }, () => new Float32Array(N)); // reference spectra, newest at this.k
    this.xi = Array.from({ length: P }, () => new Float32Array(N));
    this.pow = new Float32Array(N); this.k = 0;
    this.ch = [new Channel(), new Channel()];
    this.out = [new Float32Array(B), new Float32Array(B)]; this.outAt = B; // one block of latency
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.er = new Float32Array(N); this.ei = new Float32Array(N);
    this.blocks = 0;
    // the main thread re-aligns the reference when the echo delay changes; what was learned no longer fits
    this.port.onmessage = (e) => { if (e.data === 'reset') for (const ch of this.ch) ch.reset(); };
  }
  block() {
    const { re, im } = this, k = this.k = (this.k + 1) % P;
    // reference spectrum of [previous block, this block]
    re.set(this.prevRef, 0); re.set(this.ref, B); im.fill(0); this.prevRef.set(this.ref);
    fft(re, im, false);
    this.xr[k].set(re); this.xi[k].set(im);
    let refEnergy = 0; for (let i = 0; i < B; i++) refEnergy += this.ref[i] * this.ref[i];
    const adapt = refEnergy / B > 1e-8; // nothing to learn from silence
    for (let i = 0; i < N; i++) this.pow[i] = 0.85 * this.pow[i] + 0.15 * (re[i] * re[i] + im[i] * im[i]);
    let floor = 0; for (let i = 0; i < N; i++) floor += this.pow[i]; floor = floor / N * 0.01 + 1e-10; // keeps quiet bins from blowing up
    const constrain = this.blocks++ % P; // one partition's gradient constraint per block
    for (let c = 0; c < 2; c++) {
      const ch = this.ch[c], d = this.near[c], er = this.er, ei = this.ei;
      // estimate of the echo: sum over partitions of W_p * X_(k-p)
      er.fill(0); ei.fill(0);
      for (let p = 0; p < P; p++) {
        const q = (k - p + P) % P, xr = this.xr[q], xi = this.xi[q], wr = ch.wr[p], wi = ch.wi[p];
        for (let i = 0; i < N; i++) { er[i] += wr[i] * xr[i] - wi[i] * xi[i]; ei[i] += wr[i] * xi[i] + wi[i] * xr[i]; }
      }
      fft(er, ei, true);
      const o = this.out[c];
      let nearEnergy = 0, errEnergy = 0;
      for (let i = 0; i < B; i++) { const e = d[i] - er[B + i]; o[i] = e; nearEnergy += d[i] * d[i]; errEnergy += e * e; }
      // a filter that adds energy instead of removing it has gone wrong: start over, pass the sound through
      if (errEnergy > 2 * nearEnergy + 1e-9) { if (++ch.bad > 8) { ch.reset(); o.set(d); this.port.postMessage('reset'); } } else ch.bad = 0;
      if (!adapt) continue;
      er.fill(0); ei.fill(0); for (let i = 0; i < B; i++) er[B + i] = o[i];
      fft(er, ei, false);
      for (let i = 0; i < N; i++) { const g = MU / (this.pow[i] + floor); er[i] *= g; ei[i] *= g; }
      for (let p = 0; p < P; p++) {
        const q = (k - p + P) % P, xr = this.xr[q], xi = this.xi[q], wr = ch.wr[p], wi = ch.wi[p];
        // W_p += mu * conj(X) * E
        for (let i = 0; i < N; i++) { wr[i] += xr[i] * er[i] + xi[i] * ei[i]; wi[i] += xr[i] * ei[i] - xi[i] * er[i]; }
      }
      // keep the constrained partition a true linear filter (no wrap-around): zero its second half in time
      const wr = ch.wr[constrain], wi = ch.wi[constrain];
      fft(wr, wi, true); for (let i = B; i < N; i++) { wr[i] = 0; wi[i] = 0; } fft(wr, wi, false);
    }
  }
  process(inputs, outputs) {
    const near = inputs[0], ref = inputs[1], out = outputs[0];
    const n = (out[0] || []).length || 128;
    for (let i = 0; i < n; i++) {
      const l = near[0] ? near[0][i] : 0, r = near[1] ? near[1][i] : l;
      let x = 0; if (ref && ref.length) { for (let c = 0; c < ref.length; c++) x += ref[c][i]; x /= ref.length; }
      this.near[0][this.fill] = l; this.near[1][this.fill] = r; this.ref[this.fill] = x;
      if (++this.fill === B) { this.fill = 0; this.block(); this.outAt = 0; }
      for (let c = 0; c < out.length; c++) out[c][i] = this.outAt < B ? this.out[Math.min(c, 1)][this.outAt] : 0;
      this.outAt++;
    }
    return true;
  }
}
registerProcessor('dischord-echo-cancel', EchoCancel);
