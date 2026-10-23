// Copyright 2013 Google Inc. All rights reserved.
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
/** A class to play a series of sample buffers at a constant rate using the Web Audio API. */
export class AudioPlayer {
    static OUT_RATE = 48000;
    constructor(options) {
        this.newAudioContext =
            options?.newAudioContext || (() => new AudioContext());
        this.timeBuffer = options?.timeBuffer || 0.05;
        this.pool = new Map();
        this.lastPlayedAt = -1;
        this.ac = undefined;
        this.gainNode = undefined;
        this.gain = 0;
    }
    newAudioContext;
    timeBuffer;
    pool = new Map();
    lastPlayedAt;
    ac;
    gainNode;
    gain;
    /**
     * Queues the given samples for playing at the appropriate time.
     * @param leftSamples The samples for the left speaker.
     * @param rightSamples The samples for the right speaker.
     */
    play(leftSamples, rightSamples) {
        if (this.ac === undefined || this.gainNode === undefined) {
            this.ac = this.newAudioContext();
            this.gainNode = this.ac.createGain();
            this.gainNode.gain.value = this.gain;
            this.gainNode.connect(this.ac.destination);
        }
        let now = this.ac.currentTime;
        let next = this.lastPlayedAt + leftSamples.length / AudioPlayer.OUT_RATE;
        this.lastPlayedAt = next > now ? next : now + this.timeBuffer;
        const buffer = this.getBuffer(leftSamples.length);
        buffer.copyToChannel(leftSamples, 0);
        buffer.copyToChannel(rightSamples, 1);
        let source = new AudioBufferSourceNode(this.ac, { buffer: buffer });
        source.connect(this.gainNode);
        source.onended = () => this.returnBuffer(buffer);
        source.start(this.lastPlayedAt);
    }
    /**
     * Sets the volume for playing samples.
     * @param volume The volume to set, between 0 and 1.
     */
    setVolume(volume) {
        this.gain = volume;
        if (this.gainNode !== undefined) {
            this.gainNode.gain.value = volume;
        }
    }
    getVolume() {
        return this.gain;
    }
    get sampleRate() {
        if (this.ac)
            return this.ac.sampleRate;
        return 48000;
    }
    getBuffer(length) {
        let items = this.pool.get(length);
        if (items && items.length > 0) {
            return items.pop();
        }
        return new AudioBuffer({
            sampleRate: AudioPlayer.OUT_RATE,
            numberOfChannels: 2,
            length: length,
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
