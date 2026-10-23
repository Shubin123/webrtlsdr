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
 * A SignalSource that outputs samples in real time.
 *
 * This source holds a small buffer that it feeds by calling the getSamples() method.
 * Then, at periodic intervals, it checks if there are any pending reads and resolves
 * them with the contents of the buffer, refilling it as needed.
 */
export class RealTimeSource {
    constructor() {
        this.sampleRate = 1024000;
        this.centerFrequency = 0;
        this.I = new Float32RingBuffer(Math.max(65536, this.sampleRate / 10));
        this.Q = new Float32RingBuffer(this.I.capacity);
        this.lastSampleInBuffer = 0;
        this.inPool = new IqPool(1, 65536);
        this.outPool = new IqPool(16, 65536);
        this.pendingReads = new PendingReadRing(8);
        this.running = false;
        this.firstTs = null;
    }
    /** The source's sample rate. */
    sampleRate;
    /** The source's center frequency. */
    centerFrequency;
    I;
    Q;
    lastSampleInBuffer;
    inPool;
    outPool;
    pendingReads;
    running;
    firstTs;
    /**
     * Fills the provided I and Q arrays with samples starting at the given firstSample number. */
    getSamples(firstSample, I, Q) {
        I.fill(0);
        Q.fill(0);
    }
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
        this.firstTs = null;
        this.lastSampleInBuffer = 0;
        this.running = true;
        this.schedule();
    }
    readSamples(length) {
        return this.pendingReads.add(length);
    }
    async close() {
        this.running = false;
        this.pendingReads.cancel();
    }
    /** Schedules the next frame. */
    schedule() {
        setTimeout(() => this.frame(performance.now()), 16);
    }
    /** Fills the buffer and resolves promises for samples that become available in this frame. */
    frame(ts) {
        if (!this.running)
            return;
        if (this.firstTs === null)
            this.firstTs = ts;
        const curSample = Math.floor(((ts - this.firstTs) * this.sampleRate) / 1000);
        // We always try to fill the buffer when there are no pending reads.
        if (this.I.capacity > this.I.available &&
            !this.pendingReads.hasPendingRead()) {
            this.fillBuffer(curSample);
        }
        while (this.pendingReads.hasPendingRead()) {
            const firstSampleInBuffer = this.lastSampleInBuffer - this.I.available;
            const canRead = curSample - firstSampleInBuffer;
            const readSize = this.pendingReads.nextReadSize();
            if (readSize > canRead) {
                break;
            }
            if (canRead > this.I.available) {
                // We ran out of data while resolving pending reads, so fill the buffer.
                // This is not desireable, because now we will have jitter.
                this.fillBuffer(curSample);
                continue;
            }
            let [I, Q] = this.outPool.get(readSize);
            this.I.moveTo(I);
            this.Q.moveTo(Q);
            this.pendingReads.resolve({ I, Q, frequency: this.centerFrequency });
        }
        this.schedule();
    }
    /** Fills the buffer with samples to satisfy future reads. */
    fillBuffer(curSample) {
        let startWant = curSample - this.pendingReads.nextReadSize();
        const firstSampleInBuffer = this.lastSampleInBuffer - this.I.available;
        const endSampleInBuffer = firstSampleInBuffer + this.I.capacity;
        let fillStart;
        let fillCount;
        if (startWant >= endSampleInBuffer) {
            fillStart = startWant;
            fillCount = this.I.capacity;
        }
        else if (curSample >= endSampleInBuffer) {
            fillStart = this.lastSampleInBuffer;
            fillCount = curSample - this.lastSampleInBuffer;
        }
        else {
            fillStart = this.lastSampleInBuffer;
            fillCount = this.I.capacity - this.I.available;
        }
        if (fillCount == 0)
            return;
        let [I, Q] = this.inPool.get(fillCount);
        this.getSamples(fillStart, I, Q);
        this.I.store(I);
        this.Q.store(Q);
        this.lastSampleInBuffer = fillStart + fillCount;
    }
}
