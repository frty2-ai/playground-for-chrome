/**
 * The tutor's microphone on the audio thread: the learner's voice at the
 * context's own rate (usually 48 kHz) down to 16 kHz mono PCM16
 * little-endian, cut into frames of `frameMs` (40 ms by default), each
 * already tagged with the protocol's first byte (0x01, mic) so the offscreen
 * document can put it on the WebSocket as it is. Box-filter decimation: each
 * output sample is the mean of the input samples it covers, which is enough
 * low-pass for speech.
 *
 * Posts {frame: ArrayBuffer, rms} per frame (the buffer is transferred).
 */
class Frty2TutorMic extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameMs = (options && options.processorOptions && options.processorOptions.frameMs) || 40;
    this.ratio = sampleRate / 16000;
    this.size = Math.round(16000 * frameMs / 1000);   // output samples per frame
    this.out = new Int16Array(this.size);
    this.n = 0;                                       // output samples filled
    this.acc = 0;                                     // input sum for the sample being built
    this.accN = 0;
    this.pos = 0;                                     // input position within the current output sample
    this.sq = 0;
  }

  push(v) {
    const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
    this.out[this.n] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.sq += clamped * clamped;
    this.n += 1;
    if (this.n < this.size) return;
    const bytes = new ArrayBuffer(1 + this.size * 2);
    const view = new DataView(bytes);
    view.setUint8(0, 0x01);
    for (let i = 0; i < this.size; i += 1) view.setInt16(1 + i * 2, this.out[i], true);
    this.port.postMessage({frame: bytes, rms: Math.sqrt(this.sq / this.size)}, [bytes]);
    this.n = 0;
    this.sq = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const length = channel ? channel.length : 128;
    for (let i = 0; i < length; i += 1) {
      this.acc += channel ? channel[i] : 0;
      this.accN += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.push(this.acc / this.accN);
        this.acc = 0;
        this.accN = 0;
      }
    }
    return true;
  }
}

registerProcessor('frty2-tutor-mic', Frty2TutorMic);
