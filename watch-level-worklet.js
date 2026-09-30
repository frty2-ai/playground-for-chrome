/**
 * Microphone level for the Watch recorder, on the audio thread: it keeps
 * time even when the offscreen document's timers are throttled, so the
 * recorder's heartbeat (and with it the on-page "watching" indicator) rides
 * on these messages. One message per 50 ms block: RMS and peak, linear.
 */
class Frty2Level extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.peak = 0;
    this.count = 0;
    this.block = Math.round(sampleRate * 0.05);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        const v = channel[i];
        this.sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
      }
      this.count += channel.length;
    } else {
      this.count += 128;                     // silence still keeps the clock
    }
    if (this.count >= this.block) {
      this.port.postMessage({rms: Math.sqrt(this.sum / this.count), peak: this.peak});
      this.sum = 0; this.peak = 0; this.count = 0;
    }
    return true;
  }
}

registerProcessor('frty2-level', Frty2Level);
