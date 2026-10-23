// Copyright 2025 Jacobo Tarrio Barreiro. All rights reserved.
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
import { Float32RingBuffer, IqPool } from "../dsp/buffers.js";
import { PendingReadRing } from "./read_ring.js";
/**
 * A SignalSource that gets samples from a "push" source.
 *
 * You use PushSource when your signal comes in the form of events
 * or callbacks that arrive regularly (push events).
 *
 * Whenever you receive the push event or callback, you must call
 * pushSamples(). This function will use the provided samples to resolve
 * pending reads, and then store the remainder in a buffer.
 *
 * The push source is expected to deliver its signals in real time.
 */
export class PushSource {
    constructor() {
        this.sampleRate = 1024000;
        this.centerFrequency = 0;
        this.I = new Float32RingBuffer(Math.max(65536, this.sampleRate / 10));
        this.Q = new Float32RingBuffer(this.I.capacity);
        this.outPool = new IqPool(16, 65536);
        this.pendingReads = new PendingReadRing(8);
    }
    sampleRate;
    centerFrequency;
    I;
    Q;
    outPool;
    pendingReads;
    async setParameter(_property, _value) { }
    async setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
        this.I = new Float32RingBuffer(Math.max(65536, this.sampleRate / 10));
        this.Q = new Float32RingBuffer(this.I.capacity);
        return this.sampleRate;
    }
    async setCenterFrequency(freq) {
        this.centerFrequency = freq;
        return this.centerFrequency;
    }
    async startReceiving() {
        this.I.clear();
        this.Q.clear();
    }
    pushSamples(I, Q, frequency) {
        if (frequency !== undefined)
            this.centerFrequency = frequency;
        let pos = 0;
        while (this.pendingReads.hasPendingRead() && pos < I.length) {
            const remaining = I.length - pos;
            const readSize = this.pendingReads.nextReadSize();
            if (readSize > this.I.available + remaining)
                break;
            let [oI, oQ] = this.outPool.get(readSize);
            let copied = this.I.moveTo(oI);
            if (copied > 0)
                this.Q.moveTo(oQ);
            if (copied < oI.length) {
                const end = pos + oI.length - copied;
                oI.set(I.subarray(pos, end), copied);
                oQ.set(Q.subarray(pos, end), copied);
                pos = end;
            }
            this.pendingReads.resolve({
                I: oI,
                Q: oQ,
                frequency: this.centerFrequency,
            });
        }
        if (pos < I.length) {
            this.I.store(I.subarray(pos));
            this.Q.store(Q.subarray(pos));
            return;
        }
    }
    readSamples(length) {
        if (this.I.available < length || this.pendingReads.hasPendingRead()) {
            return this.pendingReads.add(length);
        }
        let [oI, oQ] = this.outPool.get(length);
        this.I.moveTo(oI);
        this.Q.moveTo(oQ);
        return Promise.resolve({
            I: oI,
            Q: oQ,
            frequency: this.centerFrequency,
        });
    }
    async close() {
        this.pendingReads.cancel();
    }
}
