// AudioWorkletProcessor for Jack's push-to-talk / barge-in microphone
// capture. Replaces ScriptProcessorNode (see useLocalRecorder.ts) --
// process() below is called by the audio thread every 128-sample render
// quantum regardless of any main-thread activity, which is what
// ScriptProcessorNode could not guarantee.
//
// This node is created with numberOfOutputs: 1, connected through a GainNode
// pinned to 0 into AudioContext.destination (see useLocalRecorder.ts) --
// guaranteeing the graph is pulled every render quantum regardless of a
// zero-output node's active-graph heuristics, while process() below never
// writes to `outputs`, so the buffer stays silent (all zeros) and the
// downstream gain=0 mutes it a second time over. The microphone is never
// actually audible.
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Batch a handful of 128-sample render quanta before posting to the
    // main thread -- far finer-grained than ScriptProcessorNode's old
    // 1024-sample floor, but still bounded so postMessage isn't called
    // ~375 times/sec.
    this._batchSamples = 512;
    this._buffer = new Float32Array(this._batchSamples);
    this._writeIndex = 0;
    this._stopped = false;

    this.port.onmessage = (event) => {
      if (event.data === "stop") this._stopped = true;
    };
  }

  _flush() {
    if (this._writeIndex === 0) return;
    const chunk = this._buffer.slice(0, this._writeIndex);
    this.port.postMessage(chunk, [chunk.buffer]);
    this._writeIndex = 0;
  }

  process(inputs) {
    if (this._stopped) {
      this._flush();
      return false;
    }
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length > 0) {
      for (let i = 0; i < channel.length; i++) {
        this._buffer[this._writeIndex++] = channel[i];
        if (this._writeIndex >= this._batchSamples) this._flush();
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PcmRecorderProcessor);
