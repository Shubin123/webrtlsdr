// Copyright 2026 Jacobo Tarrio Barreiro. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Based on AudioPlayer from @jtarrio/signals.

/**
 * An audio player compatible with the Demodulator's Player interface that
 * also measures the output level and can record the audio to a local file.
 *
 * The audio context is created on demand, but it should be resumed from a
 * user gesture (`resume()`) so the browser's autoplay policy lets it play.
 */
export class RecordingPlayer {
  static OUT_RATE = 48000;

  constructor() {
    this.ac = undefined;
    this.gainNode = undefined;
    this.recordNode = undefined;
    this.recorder = undefined;
    this.gain = 0;
    this.timeBuffer = 0.05;
    this.lastPlayedAt = -1;
    this.level = 0;
    this.pool = new Map();
    /** Called with every block of demodulated audio, before the volume is applied. */
    this.onAudio = undefined;
  }

  get sampleRate() {
    return RecordingPlayer.OUT_RATE;
  }

  /** Creates the audio context if needed and makes sure it is running. */
  resume() {
    return this.context().resume();
  }

  context() {
    if (this.ac === undefined) {
      this.ac = new AudioContext();
      this.gainNode = this.ac.createGain();
      this.gainNode.gain.value = this.gain;
      this.gainNode.connect(this.ac.destination);
      this.recordNode = this.ac.createMediaStreamDestination();
      this.gainNode.connect(this.recordNode);
    }
    return this.ac;
  }

  play(left, right) {
    if (this.onAudio) this.onAudio(left, right);
    const ac = this.context();
    let sum = 0;
    for (let i = 0; i < left.length; ++i) sum += left[i] * left[i];
    this.level = Math.sqrt(sum / Math.max(1, left.length));

    const now = ac.currentTime;
    const next = this.lastPlayedAt + left.length / RecordingPlayer.OUT_RATE;
    this.lastPlayedAt = next > now ? next : now + this.timeBuffer;
    const buffer = this.getBuffer(left.length);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    const source = new AudioBufferSourceNode(ac, { buffer });
    source.connect(this.gainNode);
    source.onended = () => this.returnBuffer(buffer);
    source.start(this.lastPlayedAt);
  }

  setVolume(volume) {
    this.gain = volume;
    if (this.gainNode !== undefined) this.gainNode.gain.value = volume;
  }

  getVolume() {
    return this.gain;
  }

  isRecording() {
    return this.recorder !== undefined;
  }

  startRecording() {
    this.context();
    const chunks = [];
    this.recorder = new MediaRecorder(this.recordNode.stream);
    this.recorder.ondataavailable = (e) => chunks.push(e.data);
    this.recorded = new Promise((resolve) => {
      this.recorder.onstop = () =>
        resolve(new Blob(chunks, { type: this.recorder.mimeType }));
    });
    this.recorder.start();
  }

  /** Stops recording and returns the recorded audio as a Blob. */
  async stopRecording() {
    if (this.recorder === undefined) return undefined;
    const recorder = this.recorder;
    recorder.stop();
    const blob = await this.recorded;
    this.recorder = undefined;
    return { blob, mimeType: recorder.mimeType };
  }

  getBuffer(length) {
    const items = this.pool.get(length);
    if (items && items.length > 0) return items.pop();
    return new AudioBuffer({
      sampleRate: RecordingPlayer.OUT_RATE,
      numberOfChannels: 2,
      length,
    });
  }

  returnBuffer(buffer) {
    let items = this.pool.get(buffer.length);
    if (!items) {
      items = [];
      this.pool.set(buffer.length, items);
    }
    items.push(buffer);
  }
}
