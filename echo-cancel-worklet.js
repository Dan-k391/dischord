/* Takes this app's own call audio back out of shared computer sound, for systems that cannot leave one program
   out of what they capture (Windows 10). Input 0 is the captured sound (stereo), input 1 the reference: exactly
   what the call is playing. Each channel runs a partitioned-block frequency-domain adaptive filter (PBFDAF): it
   learns how the reference reaches the capture (a fixed digital path: playback buffers, mixing, capture) and
   subtracts its estimate. 32 partitions of 256 samples cover about 170 ms of delay at 48 kHz. */
const B = 256, N = 512, P = 32;
const MU = 0.35; // step size: converges in a few seconds of call audio
// Where the capture holds much more than the call could explain (a game, a video, music), learning slows down in
// that frequency, or the filter would chase the other sound and turn it into a robotic copy of the voice.
const KAPPA = 3;

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
    this.nearSum = 0; this.errSum = 0; this.blocks = 0; // what came in and went out over the last ~0.35 s
    this.epow = new Float32Array(N); // smoothed power of what is left, per bin
  }
  reset() { for (let p = 0; p < P; p++) { this.wr[p].fill(0); this.wi[p].fill(0); } this.epow.fill(0); this.nearSum = 0; this.errSum = 0; this.blocks = 0; }
}

class EchoCancel extends AudioWorkletProcessor {
  constructor() {
    super();
    this.near = [new Float32Array(B), new Float32Array(B)]; this.ref = new Float32Array(B); this.fill = 0;
    this.prevRef = new Float32Array(B);
    this.xr = Array.from({ length: P }, () => new Float32Array(N)); // reference spectra, newest at this.k
    this.xi = Array.from({ length: P }, () => new Float32Array(N));
    this.pow = new Float32Array(N); this.k = 0; // per bin: reference power summed over all P partitions
    this.ch = [new Channel(), new Channel()];
    this.out = [new Float32Array(B), new Float32Array(B)]; this.outAt = B; // one block of latency
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.er = new Float32Array(N); this.ei = new Float32Array(N); this.err = new Float32Array(B);
    this.blocks = 0; this.refPeak = 0;
    // the main thread re-aligns the reference when the echo delay changes; what was learned no longer fits
    this.port.onmessage = (e) => { if (e.data === 'reset') for (const ch of this.ch) ch.reset(); };
  }
  block() {
    const { re, im } = this, k = this.k = (this.k + 1) % P;
    // reference spectrum of [previous block, this block]
    re.set(this.prevRef, 0); re.set(this.ref, B); im.fill(0); this.prevRef.set(this.ref);
    fft(re, im, false);
    // The step is normalised by the power of everything the filter spans, not just this block: speech stops
    // and starts, and a quiet block after a loud word would otherwise make a huge step and blow the filter up.
    const oldR = this.xr[k], oldI = this.xi[k];
    for (let i = 0; i < N; i++) this.pow[i] = Math.max(0, this.pow[i] + re[i] * re[i] + im[i] * im[i] - oldR[i] * oldR[i] - oldI[i] * oldI[i]);
    this.xr[k].set(re); this.xi[k].set(im);
    if (this.blocks % P === 0) { // recount now and then, so rounding in the running sum cannot build up
      this.pow.fill(0);
      for (let p = 0; p < P; p++) { const xr = this.xr[p], xi = this.xi[p]; for (let i = 0; i < N; i++) this.pow[i] += xr[i] * xr[i] + xi[i] * xi[i]; }
    }
    let refEnergy = 0; for (let i = 0; i < B; i++) refEnergy += this.ref[i] * this.ref[i]; refEnergy /= B;
    // Learn only while the call is clearly playing: in the pauses between words the reference is nearly silent,
    // and a step scaled up to match it would let any other sound (a game, a video) drag the filter off course.
    this.refPeak = Math.max(refEnergy, this.refPeak * 0.9995); // decays over about 10 s
    const adapt = refEnergy > 1e-6 && refEnergy > this.refPeak * 1e-3; // above -60 dBFS and within 30 dB of recent speech
    let floor = 0; for (let i = 0; i < N; i++) floor += this.pow[i]; floor = floor / N * 0.01 + P * N * 1e-6; // keeps quiet bins from blowing up
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
      const o = this.out[c], err = this.err;
      let nearEnergy = 0, errEnergy = 0;
      for (let i = 0; i < B; i++) { const e = d[i] - er[B + i]; err[i] = e; o[i] = e; nearEnergy += d[i] * d[i]; errEnergy += e * e; }
      // A block the filter made clearly louder goes out as captured, so there are no bursts. (That happens for a
      // moment when a word starts: the echo has not arrived yet.) Only a filter that has made the sound louder
      // over a third of a second has gone wrong and starts over; resetting on single blocks wiped out what it
      // had learned at every word.
      if (errEnergy > 2 * nearEnergy + 1e-9) o.set(d);
      ch.nearSum += nearEnergy; ch.errSum += errEnergy;
      if (++ch.blocks === 64) {
        if (ch.errSum > 2 * ch.nearSum + 64 * B * 1e-6) { ch.reset(); this.port.postMessage('reset'); }
        ch.nearSum = 0; ch.errSum = 0; ch.blocks = 0;
      }
      if (!adapt) continue;
      er.fill(0); ei.fill(0); for (let i = 0; i < B; i++) er[B + i] = err[i];
      fft(er, ei, false);
      const epow = ch.epow;
      for (let i = 0; i < N; i++) { epow[i] = 0.7 * epow[i] + 0.3 * (er[i] * er[i] + ei[i] * ei[i]); const g = MU / (this.pow[i] + KAPPA * P * epow[i] + floor); er[i] *= g; ei[i] *= g; }
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
