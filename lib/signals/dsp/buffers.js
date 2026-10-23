// Copyright 2024 Jacobo Tarrio Barreiro. All rights reserved.
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
/**
 * A fixed-size pool of pre-allocated arrays.
 *
 * Each call to get() returns the next array of the pool, if it's already the requested size.
 * If the next array is larger than the requested size, the function returns a subarray.
 * If the next array is smaller than the requested size, the function allocates a new array,
 * replaces the old array with the new array, and returns that one.
 */
class Pool {
    make;
    /**
     * @param make A function that returns an array of the given length.
     * @param count The number of arrays to keep around. Having more than 1 lets you modify one array while you use another.
     * @param length An optional initial length for the arrays.
     */
    constructor(make, count, length) {
        this.make = make;
        this.buffers = [...Array(count).keys()].map(() => make(length || 0));
        this.current = 0;
    }
    buffers;
    current;
    /** Returns an array of the given size. You may need to clear it manually. */
    get(length) {
        let out = this.buffers[this.current];
        if (out.length < length) {
            out = this.make(length);
            this.buffers[this.current] = out;
        }
        this.current = (this.current + 1) % this.buffers.length;
        if (out.length == length)
            return out;
        return out.subarray(0, length);
    }
}
/**
 * A fixed-size pool of pre-allocated Uint8Arrays.
 */
export class U8Pool extends Pool {
    /**
     * @param count The number of arrays to keep around. Having more than 1 lets you modify one array while you use another.
     * @param length An optional initial size for the arrays.
     */
    constructor(count, length) {
        super((l) => new Uint8Array(l), count, length);
    }
}
/**
 * A fixed-size pool of pre-allocated Float32Arrays.
 */
export class Float32Pool extends Pool {
    /**
     * @param count The number of arrays to keep around. Having more than 1 lets you modify one array while you use another.
     * @param length An optional initial size for the arrays.
     */
    constructor(count, length) {
        super((l) => new Float32Array(l), count, length);
    }
}
/**
 * A pool of pre-allocated [Float32Array, Float32Array] array pairs.
 */
export class IqPool {
    /**
     * @param count The number of array pairs to keep around. Having more than 1 lets you modify one pair while you use another.
     * @param length An optional initial size for the arrays.
     */
    constructor(count, length) {
        this.pools = new Float32Pool(count * 2, length);
    }
    pools;
    /** Returns a pair of arrays of the given size. You may need to clear them manually. */
    get(length) {
        return [this.pools.get(length), this.pools.get(length)];
    }
}
/**
 * A variable-size ring buffer, where you can store data and then access up to the latest N values.
 */
class RingBuffer {
    buffer;
    constructor(buffer) {
        this.buffer = buffer;
        this.readPos = 0;
        this.writePos = 0;
        this.filled = 0;
    }
    readPos;
    writePos;
    filled;
    /** Returns the ring buffer's capacity. */
    get capacity() {
        return this.buffer.length;
    }
    /** Returns the number of values that can be accessed using moveTo. */
    get available() {
        return this.filled;
    }
    /** Empties the ring buffer. */
    clear() {
        this.readPos = 0;
        this.writePos = 0;
        this.filled = 0;
    }
    /**
     * Stores repeated copies of a value in the ring buffer.
     *
     * @param value the value to store.
     * @param count the number of copies to store. The whole ring buffer is filled if not specified.
     * */
    fill(value, count) {
        if (count === undefined || count >= this.buffer.length) {
            this.buffer.fill(value);
            this.readPos = 0;
            this.writePos = 0;
            this.filled = this.buffer.length;
            return;
        }
        let remaining = count;
        let dstOffset = this.writePos;
        while (remaining > 0) {
            const copyCount = Math.min(remaining, this.buffer.length - this.writePos);
            this.buffer.subarray(dstOffset, dstOffset + copyCount).fill(value);
            dstOffset = (dstOffset + copyCount) % this.buffer.length;
            remaining -= copyCount;
        }
        this.writePos = dstOffset;
        this.filled = Math.min(this.buffer.length, this.filled + count);
        if (this.filled == this.buffer.length) {
            this.readPos = this.writePos;
        }
    }
    /** Copies the provided data into the ring buffer. */
    store(data) {
        let count = Math.min(data.length, this.buffer.length);
        let { dstOffset } = this.doCopy(count, data, data.length - count, this.buffer, this.writePos);
        this.writePos = dstOffset;
        this.filled = Math.min(this.buffer.length, this.filled + count);
        if (this.filled == this.buffer.length) {
            this.readPos = this.writePos;
        }
    }
    /**
     * Fills the provided array with values from the ring buffer,
     * consuming it in the same order as the values were written.
     * Returns the number of values copied.
     */
    moveTo(data) {
        let count = Math.min(data.length, this.buffer.length, this.filled);
        if (count == 0)
            return 0;
        let { srcOffset } = this.doCopy(count, this.buffer, this.readPos, data, 0);
        this.readPos = srcOffset;
        this.filled -= count;
        return count;
    }
    /**
     * Consumes a number of values from the ring buffer, as if they had been read through moveTo().
     * @param count the number of values to consume.
     */
    consume(count) {
        let discard = Math.min(this.filled, count);
        this.readPos = (this.readPos + discard) % this.buffer.length;
        this.filled -= discard;
    }
    /**
     * Fills the provided array with the latest values stored in the ring buffer,
     * without consuming it and without taking into account the values consumed
     * by moveTo.
     */
    copyTo(data) {
        let count = Math.min(data.length, this.buffer.length);
        let srcOffset = (this.writePos + this.buffer.length - count) % this.buffer.length;
        this.doCopy(count, this.buffer, srcOffset, data, 0);
    }
    doCopy(count, src, srcOffset, dst, dstOffset) {
        while (count > 0) {
            const copyCount = Math.min(count, src.length - srcOffset, dst.length - dstOffset);
            dst.set(src.subarray(srcOffset, srcOffset + copyCount), dstOffset);
            srcOffset = (srcOffset + copyCount) % src.length;
            dstOffset = (dstOffset + copyCount) % dst.length;
            count -= copyCount;
        }
        return { srcOffset, dstOffset };
    }
}
/**
 * A Float32 variable-size ring buffer, where you can store data and then retrieve the latest N values.
 */
export class Float32RingBuffer extends RingBuffer {
    constructor(size) {
        super(new Float32Array(size));
    }
}
/**
 * A ring buffer for I/Q signals.
 */
export class IqRingBuffer {
    constructor(size) {
        this.ringI = new Float32RingBuffer(size);
        this.ringQ = new Float32RingBuffer(size);
    }
    ringI;
    ringQ;
    /** Returns the ring buffer's capacity. */
    get capacity() {
        return this.ringI.capacity;
    }
    /** Returns the number of values that can be accessed using moveTo. */
    get available() {
        return this.ringI.available;
    }
    /** Empties the ring buffer. */
    clear() {
        this.ringI.clear();
        this.ringQ.clear();
    }
    /**
     * Stores repeated copies of a value in the ring buffer.
     *
     * @param real the real part of the value to store.
     * @param imag the imaginary part of the value to store.
     * @param count the number of copies to store. The whole ring buffer is filled if not specified.
     * */
    fill(real, imag, count) {
        this.ringI.fill(real, count);
        this.ringQ.fill(imag, count);
    }
    /** Copies the provided data into the ring buffer. */
    store(real, imag) {
        if (real.length == imag.length) {
            this.ringI.store(real);
            this.ringQ.store(imag);
        }
        else {
            let l = Math.min(real.length, imag.length);
            this.ringI.store(real.subarray(0, l));
            this.ringQ.store(imag.subarray(0, l));
        }
    }
    /**
     * Fills the provided array with values from the ring buffer,
     * consuming it in the same order as the values were written.
     * Returns the number of values copied.
     */
    moveTo(real, imag) {
        this.ringI.moveTo(real);
        return this.ringQ.moveTo(imag);
    }
    /**
     * Consumes a number of values from the ring buffer, as if they had been read through moveTo().
     * @param count the number of values to consume.
     */
    consume(count) {
        this.ringI.consume(count);
        this.ringQ.consume(count);
    }
    /**
     * Fills the provided array with the latest values stored in the ring buffer,
     * without consuming it and without taking into account the values consumed
     * by moveTo.
     */
    copyTo(real, imag) {
        this.ringI.copyTo(real);
        this.ringQ.copyTo(imag);
    }
}
