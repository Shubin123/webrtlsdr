// Copyright 2024 Jacobo Tarrio Barreiro. All rights reserved.
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
import { getConvolver } from "../wasm/convolver.js";
import { Float32Pool, Float32RingBuffer, IqPool, IqRingBuffer, } from "./buffers.js";
import { actualLength, FFT, RealFFT } from "./fft.js";
import { atan2 } from "./math.js";
/** A base implementation for FIR filters that uses WASM for convolution. */
export class BaseWasmFirFilter {
    offset;
    delay;
    /** @param coefs The coefficients of the filter to apply. */
    constructor(offset, delay) {
        this.offset = offset;
        this.delay = delay;
        this.pool = new Float32Pool(2, 2 * this.offset);
        this.curSamples = this.pool.get(this.offset);
        this.convolver = getConvolver();
    }
    pool;
    curSamples;
    convolver;
    getDelay() {
        return this.delay;
    }
    /**
     * Loads a new block of samples to filter.
     * @param samples The samples to load.
     */
    loadSamples(samples) {
        const len = samples.length + this.offset;
        if (this.curSamples.length != len) {
            let newSamples = this.pool.get(len);
            newSamples.set(this.curSamples.subarray(this.curSamples.length - this.offset));
            this.curSamples = newSamples;
        }
        else {
            this.curSamples.copyWithin(0, samples.length);
        }
        this.curSamples.set(samples, this.offset);
    }
}
/** A class to apply a FIR filter to a sequence of samples. */
export class FIRFilter extends BaseWasmFirFilter {
    coefs;
    /** @param coefs The coefficients of the filter to apply. */
    constructor(coefs) {
        super(coefs.length - 1, Math.floor(coefs.length / 2));
        this.coefs = coefs;
        this.convolver.setCoefs(coefs);
    }
    setCoefficients(coefs) {
        this.convolver.setCoefs(coefs);
        const oldSamples = this.curSamples;
        this.coefs = coefs;
        this.offset = this.coefs.length - 1;
        this.delay = Math.floor(this.coefs.length / 2);
        this.curSamples = this.pool.get(this.offset);
        this.loadSamples(oldSamples);
    }
    clone() {
        return new FIRFilter(this.coefs);
    }
    getDelay() {
        return this.delay;
    }
    inPlace(samples) {
        this.loadSamples(samples);
        samples.set(this.convolver.convolve(this.curSamples, samples.length));
    }
}
/**
 * A class that applies a FIR filter using successive Fourier transforms (overlap-save.)
 *
 * You can use the length of the coefficients to trade off CPU time vs latency.
 * - When the number of coefficients is (2^n)-1, you get the least latency [3*2^(n-1)+1]
 * but the most CPU usage because almost half of the FFT result is thrown away.
 * - When the number of coefficients is (2^n)+1, you get the most latency [7*2^(n-1)]
 * but the least CPU usage because only a quarter of the FFT result is thrown away.
 */
export class FFTFilter {
    constructor(coefs) {
        this.fft = RealFFT.ofLength(coefs.length * 2);
        this.kernel = this.computeKernel(coefs);
        this.overlap = coefs.length - 1;
        this.input = new Float32RingBuffer(this.fft.length);
        this.input.fill(0, this.overlap);
        this.work = new Float32Array(this.fft.length);
        this.output = new Float32RingBuffer((this.fft.length - this.overlap) * 2);
        this.output.fill(0, this.fft.length - this.overlap);
    }
    fft;
    kernel;
    overlap;
    input;
    work;
    output;
    computeKernel(coefs) {
        let copy = new Float32Array(this.fft.length);
        copy.set(coefs);
        copy.subarray(0, coefs.length).reverse();
        for (let i = 0; i < copy.length; ++i) {
            copy[i] *= copy.length;
        }
        let kernel = this.fft.transform(copy);
        return [new Float32Array(kernel[0]), new Float32Array(kernel[1])];
    }
    setCoefficients(coefs) {
        let fftLength = actualLength(coefs.length * 2);
        let newOverlap = coefs.length - 1;
        if (fftLength == this.fft.length && newOverlap == this.overlap) {
            this.kernel = this.computeKernel(coefs);
            return;
        }
        this.fft = RealFFT.ofLength(fftLength);
        this.overlap = newOverlap;
        this.kernel = this.computeKernel(coefs);
        let oldInput = new Float32Array(this.input.available);
        this.input.moveTo(oldInput);
        this.input = new Float32RingBuffer(this.fft.length);
        if (newOverlap > oldInput.length) {
            this.input.fill(0, newOverlap - oldInput.length);
        }
        this.input.store(oldInput);
        this.work = new Float32Array(this.fft.length);
        this.output = new Float32RingBuffer((this.fft.length - this.overlap) * 2);
        this.output.fill(0, this.fft.length - this.overlap);
    }
    clone() {
        let newFilter = new FFTFilter(new Float32Array(this.overlap + 1));
        newFilter.kernel = this.kernel;
        return newFilter;
    }
    getDelay() {
        return this.fft.length - this.overlap / 2;
    }
    inPlace(samples) {
        let readPos = 0;
        let writePos = 0;
        while (samples.length - readPos > 0) {
            if (this.input.available < this.input.capacity) {
                let toCopy = Math.min(samples.length - readPos, this.input.capacity - this.input.available);
                this.input.store(samples.subarray(readPos, readPos + toCopy));
                readPos += toCopy;
            }
            if (this.input.available == this.input.capacity) {
                this.input.copyTo(this.work);
                this.input.consume(this.input.capacity - this.overlap);
                let fd = this.fft.transform(this.work);
                for (let i = 0; i < fd[0].length; ++i) {
                    let sI = fd[0][i];
                    let sQ = fd[1][i];
                    let kI = this.kernel[0][i];
                    let kQ = this.kernel[1][i];
                    fd[0][i] = sI * kI - sQ * kQ;
                    fd[1][i] = sQ * kI + sI * kQ;
                }
                let td = this.fft.reverse(fd[0], fd[1]);
                this.output.store(td.subarray(this.overlap));
            }
            if (writePos < samples.length) {
                let moved = this.output.moveTo(samples.subarray(writePos, readPos));
                writePos += moved;
            }
        }
    }
}
/** A filter that works on an IQ signal. */
export class IqFIRFilter {
    constructor(coefs) {
        this.filterI = new FIRFilter(coefs);
        this.filterQ = this.filterI.clone();
    }
    filterI;
    filterQ;
    /** Changes the filters' coefficients. */
    setCoefficients(coefs) {
        this.filterI.setCoefficients(coefs);
        this.filterQ.setCoefficients(coefs);
    }
    /** Returns a newly initialized clone of this filter. */
    clone() {
        let out = new IqFIRFilter(new Float32Array(3));
        out.filterI = this.filterI.clone();
        out.filterQ = this.filterQ.clone();
        return out;
    }
    /** Returns this filter's delay, in samples. */
    getDelay() {
        return this.filterI.getDelay();
    }
    /** Applies the filter to the input samples, in place. */
    inPlace(I, Q) {
        this.filterI.inPlace(I);
        this.filterQ.inPlace(Q);
    }
}
/**
 * A class that applies a FIR filter using successive Fourier transforms (overlap-save.)
 */
export class IqFFTFilter {
    constructor(coefs) {
        this.fft = FFT.ofLength(coefs.length * 2);
        this.kernel = this.computeKernel(coefs);
        this.overlap = coefs.length - 1;
        this.input = new IqRingBuffer(this.fft.length);
        this.input.fill(0, 0, this.overlap);
        this.workI = new Float32Array(this.fft.length);
        this.workQ = new Float32Array(this.fft.length);
        this.output = new IqRingBuffer((this.fft.length - this.overlap) * 2);
        this.output.fill(0, 0, this.fft.length - this.overlap);
    }
    fft;
    kernel;
    overlap;
    input;
    workI;
    workQ;
    output;
    computeKernel(coefs) {
        let copy = new Float32Array(this.fft.length);
        copy.set(coefs);
        copy.subarray(0, coefs.length).reverse();
        for (let i = 0; i < copy.length; ++i) {
            copy[i] *= copy.length;
        }
        let kernel = RealFFT.ofLength(this.fft.length).transform(copy);
        return [new Float32Array(kernel[0]), new Float32Array(kernel[1])];
    }
    setCoefficients(coefs) {
        let fftLength = actualLength(coefs.length * 2);
        let newOverlap = coefs.length - 1;
        if (fftLength == this.fft.length && newOverlap == this.overlap) {
            this.kernel = this.computeKernel(coefs);
            return;
        }
        this.fft = FFT.ofLength(fftLength);
        this.overlap = newOverlap;
        this.kernel = this.computeKernel(coefs);
        let oldInputI = new Float32Array(this.input.available);
        let oldInputQ = new Float32Array(this.input.available);
        this.input.moveTo(oldInputI, oldInputQ);
        this.input = new IqRingBuffer(this.fft.length);
        if (newOverlap > oldInputI.length) {
            this.input.fill(0, 0, newOverlap - oldInputI.length);
        }
        this.input.store(oldInputI, oldInputQ);
        this.workI = new Float32Array(this.fft.length);
        this.workQ = new Float32Array(this.fft.length);
        this.output = new IqRingBuffer((this.fft.length - this.overlap) * 2);
        this.output.fill(0, 0, this.fft.length - this.overlap);
    }
    clone() {
        let newFilter = new IqFFTFilter(new Float32Array(this.overlap + 1));
        newFilter.kernel = this.kernel;
        return newFilter;
    }
    getDelay() {
        return this.fft.length - this.overlap / 2;
    }
    inPlace(real, imag) {
        const length = Math.min(real.length, imag.length);
        let readPos = 0;
        let writePos = 0;
        while (length - readPos > 0) {
            if (this.input.available < this.input.capacity) {
                let toCopy = Math.min(length - readPos, this.input.capacity - this.input.available);
                this.input.store(real.subarray(readPos, readPos + toCopy), imag.subarray(readPos, readPos + toCopy));
                readPos += toCopy;
            }
            if (this.input.available == this.input.capacity) {
                this.input.copyTo(this.workI, this.workQ);
                this.input.consume(this.input.capacity - this.overlap);
                let fd = this.fft.transform(this.workI, this.workQ);
                for (let i = 0; i < fd[0].length; ++i) {
                    let sI = fd[0][i];
                    let sQ = fd[1][i];
                    let kI = this.kernel[0][i];
                    let kQ = this.kernel[1][i];
                    fd[0][i] = sI * kI - sQ * kQ;
                    fd[1][i] = sQ * kI + sI * kQ;
                }
                let td = this.fft.reverse(fd[0], fd[1]);
                this.output.store(td[0].subarray(this.overlap), td[1].subarray(this.overlap));
            }
            if (writePos < length) {
                let moved = this.output.moveTo(real.subarray(writePos, readPos), imag.subarray(writePos, readPos));
                writePos += moved;
            }
        }
    }
}
/** A class to apply a delay to a sequence of samples. */
export class DelayFilter {
    /** @param delay The number of samples to delay the signal by */
    constructor(delay) {
        this.buffer = new Float32Array(delay);
        this.ptr = 0;
    }
    buffer;
    ptr;
    clone() {
        return new DelayFilter(this.getDelay());
    }
    getDelay() {
        return this.buffer.length;
    }
    inPlace(samples) {
        for (let i = 0; i < samples.length; ++i) {
            let s = samples[i];
            samples[i] = this.buffer[this.ptr];
            this.buffer[this.ptr] = s;
            this.ptr = (this.ptr + 1) % this.buffer.length;
        }
    }
}
/** Automatic gain control for audio signals. */
export class AGC {
    sampleRate;
    constructor(sampleRate, timeConstantSeconds, maxGain) {
        this.sampleRate = sampleRate;
        this.dcBlocker = new DcBlocker(sampleRate);
        this.alpha = decay(sampleRate, timeConstantSeconds);
        this.counter = 0;
        this.maxPower = 0;
        this.maxGain = maxGain || 100;
    }
    dcBlocker;
    alpha;
    counter;
    maxPower;
    maxGain;
    clone() {
        let copy = new AGC(this.sampleRate, 1, this.maxGain);
        copy.alpha = this.alpha;
        return copy;
    }
    getDelay() {
        return 0;
    }
    inPlace(samples) {
        const alpha = this.alpha;
        let maxPower = this.maxPower;
        let counter = this.counter;
        let gain;
        this.dcBlocker.inPlace(samples);
        for (let i = 0; i < samples.length; ++i) {
            const v = samples[i];
            const power = v * v;
            if (power > 0.9 * maxPower) {
                counter = this.sampleRate;
                if (power > maxPower) {
                    maxPower = power;
                }
            }
            else if (counter > 0) {
                --counter;
            }
            else {
                maxPower -= alpha * maxPower;
            }
            gain = Math.min(this.maxGain, 1 / Math.sqrt(maxPower));
            samples[i] *= gain;
        }
        this.maxPower = maxPower;
        this.counter = counter;
    }
}
/** A filter that blocks DC signals. */
export class DcBlocker {
    constructor(sampleRate) {
        this.alpha = decay(sampleRate, 0.5);
        this.dc = 0;
    }
    alpha;
    dc;
    clone() {
        let copy = new DcBlocker(1000);
        copy.alpha = this.alpha;
        copy.dc = this.dc;
        return copy;
    }
    getDelay() {
        return 0;
    }
    inPlace(samples) {
        const alpha = this.alpha;
        let dc = this.dc;
        for (let i = 0; i < samples.length; ++i) {
            dc += alpha * (samples[i] - dc);
            samples[i] -= dc;
        }
        this.dc = dc;
    }
}
/**
 * Returns the decay value to use in a single-pole low-pass or high-pass IIR filter
 * with the given time constant.
 * @param sampleRate The signal's sample rate.
 * @param timeConstant The time constant in seconds
 */
export function decay(sampleRate, timeConstant) {
    return 1 - Math.exp(-1 / (sampleRate * timeConstant));
}
/** IIR filter with two 'b' coefficients and one 'a' coefficient. */
class IIRFilter21 {
    sampleRate;
    constructor(sampleRate, b0, b1, a1) {
        this.sampleRate = sampleRate;
        this.q = [b0, b1, a1];
        this.v = [0, 0];
    }
    q;
    v;
    /** Returns a copy of this filter. */
    clone() {
        return new IIRFilter21(this.sampleRate, ...this.q);
    }
    getDelay() {
        return 0;
    }
    /**
     * Filters the given samples in place.
     * @param samples The samples to filter.
     */
    inPlace(samples) {
        let q = this.q;
        let x1 = this.v[0];
        let y1 = this.v[1];
        for (let i = 0; i < samples.length; ++i) {
            const x0 = samples[i];
            samples[i] = y1 = q[0] * x0 + q[1] * x1 + q[2] * y1;
            x1 = x0;
        }
        this.v[0] = x1;
        this.v[1] = y1;
    }
}
/** IIR filter with three 'b' coefficients and two 'a' coefficient. */
class IIRFilter32 {
    sampleRate;
    constructor(sampleRate, b0, b1, b2, a1, a2) {
        this.sampleRate = sampleRate;
        this.q = [b0, b1, b2, a1, a2];
        this.v = [0, 0, 0, 0];
    }
    q;
    v;
    /** Returns a copy of this filter. */
    clone() {
        return new IIRFilter32(this.sampleRate, ...this.q);
    }
    getDelay() {
        return 0;
    }
    /**
     * Filters the given samples in place.
     * @param samples The samples to filter.
     */
    inPlace(samples) {
        let q = this.q;
        let x1 = this.v[0];
        let x2 = this.v[1];
        let y1 = this.v[2];
        let y2 = this.v[3];
        for (let i = 0; i < samples.length; ++i) {
            let x0 = samples[i];
            let y0 = (samples[i] =
                q[0] * x0 + q[1] * x1 + q[2] * x2 + q[3] * y1 + q[4] * y2);
            y2 = y1;
            y1 = y0;
            x2 = x1;
            x1 = x0;
        }
        this.v[0] = x1;
        this.v[1] = x2;
        this.v[2] = y1;
        this.v[3] = y2;
    }
}
/** Returns the coefficients for a first-order low-pass IIR filter. */
function lowPassCoeffs21(sampleRate, frequency) {
    const wd = (2 * Math.PI * frequency) / sampleRate;
    const wa = 2 * sampleRate * Math.tan(wd / 2);
    const tau = 1 / wa;
    let a = 1 + 2 * tau * sampleRate;
    let b = 1 - 2 * tau * sampleRate;
    return [1 / a, 1 / a, -b / a];
}
/**
 * Returns the coefficients for a second-order low-pass IIR filter.
 *
 * From https://webaudio.github.io/Audio-EQ-Cookbook/Audio-EQ-Cookbook.txt
 */
function lowPassCoeffs32(sampleRate, frequency, Q) {
    let w = (2 * Math.PI * frequency) / sampleRate;
    let alpha = Math.sin(w) / (2 * Q);
    let b0 = (1 - Math.cos(w)) / 2;
    let b1 = 1 - Math.cos(w);
    let b2 = (1 - Math.cos(w)) / 2;
    let a0 = 1 + alpha;
    let a1 = -2 * Math.cos(w);
    let a2 = 1 - alpha;
    return [b0 / a0, b1 / a0, b2 / a0, -a1 / a0, -a2 / a0];
}
/** A FM de-emphasis filter. */
export class Deemphasis extends IIRFilter21 {
    /**
     * @param sampleRate The signal's sample rate.
     * @param timeConstant The filter's time constant, in seconds.
     */
    constructor(sampleRate, timeConstant) {
        super(sampleRate, ...lowPassCoeffs21(sampleRate, 1 / (2 * Math.PI * timeConstant)));
    }
}
/** A FM pre-emphasis filter. */
export class Preemphasis extends IIRFilter21 {
    /**
     * @param sampleRate The signal's sample rate.
     * @param timeConstant The filter's time constant, in seconds.
     */
    constructor(sampleRate, timeConstant) {
        const wdl = 1 / (timeConstant * sampleRate);
        const wdh = Math.PI * 0.9;
        const wal = Math.tan(wdl / 2);
        const wah = Math.tan(wdh / 2);
        const a = wal + 1;
        const b = wal - 1;
        const c = wah + 1;
        const d = wah - 1;
        const zg = wal / wah;
        super(sampleRate, a / (c * zg), b / (c * zg), -d / c);
    }
}
/** A first-order IIR low-pass filter. */
export class IIRLowPass extends IIRFilter21 {
    /**
     * @param sampleRate The signal's sample rate.
     * @param freq The filter's corner frequency.
     */
    constructor(sampleRate, freq) {
        super(sampleRate, ...lowPassCoeffs21(sampleRate, freq));
    }
}
/** A second-order IIR low-pass filter. */
export class IIRLowPass2 extends IIRFilter32 {
    /**
     * @param sampleRate The signal's sample rate.
     * @param freq The filter's corner frequency.
     * @param Q The filter's Q factor.
     */
    constructor(sampleRate, freq, Q) {
        super(sampleRate, ...lowPassCoeffs32(sampleRate, freq, Q));
    }
}
/**
 * Shifts IQ samples by a given frequency.
 */
export class FrequencyShifter {
    sampleRate;
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        this.cosine = 1;
        this.sine = 0;
    }
    cosine;
    sine;
    inPlace(I, Q, freq) {
        let cosine = this.cosine;
        let sine = this.sine;
        const deltaCos = Math.cos((2 * Math.PI * freq) / this.sampleRate);
        const deltaSin = Math.sin((2 * Math.PI * freq) / this.sampleRate);
        for (let i = 0; i < I.length; ++i) {
            const newI = I[i] * cosine - Q[i] * sine;
            Q[i] = I[i] * sine + Q[i] * cosine;
            I[i] = newI;
            const newSine = cosine * deltaSin + sine * deltaCos;
            cosine = cosine * deltaCos - sine * deltaSin;
            sine = newSine;
        }
        const m = Math.hypot(cosine, sine);
        this.cosine = cosine / m;
        this.sine = sine / m;
    }
}
/** Detects a pilot tone and returns its cosine and sine as an IQ signal. */
export class PilotDetector {
    sampleRate;
    targetFreq;
    constructor(sampleRate, targetFreq, tolerance) {
        this.sampleRate = sampleRate;
        this.targetFreq = targetFreq;
        this.iqPool = new IqPool(2);
        this.downShifter = new FrequencyShifter(sampleRate);
        this.upShifter = new FrequencyShifter(sampleRate);
        this.filterI = new IIRLowPass2(sampleRate, tolerance * 100, 1);
        this.filterQ = this.filterI.clone();
        this.prev = [1, 0];
        this.tolerance = (2 * Math.PI * tolerance) / sampleRate;
        this.speedEstimate = 0;
        this.speedDecay = decay(sampleRate, 0.25);
        this.isLocked = false;
    }
    iqPool;
    downShifter;
    upShifter;
    filterI;
    filterQ;
    prev;
    tolerance;
    speedEstimate;
    speedDecay;
    isLocked;
    get locked() {
        return this.isLocked;
    }
    extract(input) {
        const speedDecay = this.speedDecay;
        let lI = this.prev[0];
        let lQ = this.prev[1];
        let speedEstimate = this.speedEstimate;
        let out = this.iqPool.get(input.length);
        const I = out[0];
        const Q = out[1];
        I.set(input);
        Q.fill(0);
        this.downShifter.inPlace(I, Q, -this.targetFreq);
        this.filterI.inPlace(I);
        this.filterQ.inPlace(Q);
        for (let i = 0; i < I.length; ++i) {
            const m = Math.hypot(I[i], Q[i]);
            if (m > 0) {
                I[i] /= m;
                Q[i] /= m;
                speedEstimate +=
                    speedDecay *
                        (atan2(Q[i] * lI - I[i] * lQ, I[i] * lI + Q[i] * lQ) - speedEstimate);
            }
            else {
                speedEstimate += speedDecay * (2 * this.tolerance - speedEstimate);
            }
            lI = I[i];
            lQ = Q[i];
        }
        this.upShifter.inPlace(I, Q, this.targetFreq);
        this.prev[0] = lI;
        this.prev[1] = lQ;
        this.speedEstimate = speedEstimate;
        this.isLocked =
            speedEstimate >= -this.tolerance && speedEstimate <= this.tolerance;
        return out;
    }
}
