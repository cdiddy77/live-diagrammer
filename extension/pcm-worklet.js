// AudioWorklet processor. It runs on the audio thread. It mixes the input to
// mono, converts to PCM16, and posts fixed-size frames. Byte 0 of a frame is
// the channel number; the samples follow as little-endian int16.
class PcmFrames extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { frameSamples, channel } = options.processorOptions;
    this.frameSamples = frameSamples;
    this.channel = channel;
    this.frame = new Int16Array(frameSamples);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const length = input[0].length;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      const sample = Math.max(-1, Math.min(1, sum / channels));
      this.frame[this.fill++] = Math.round(sample * 32767);
      if (this.fill === this.frameSamples) this.emit();
    }
    return true;
  }

  emit() {
    const out = new Uint8Array(1 + this.frameSamples * 2);
    out[0] = this.channel;
    out.set(new Uint8Array(this.frame.buffer), 1);
    this.port.postMessage(out.buffer, [out.buffer]);
    this.fill = 0;
  }
}

registerProcessor("pcm-frames", PcmFrames);
