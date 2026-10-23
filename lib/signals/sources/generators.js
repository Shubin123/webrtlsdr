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
import { IqPool } from "../dsp/buffers.js";
import { Preemphasis } from "../dsp/filters.js";
/** Returns a generator for a tone at the given frequency with the given amplitude. */
export function tone(freq, amplitude, phase) {
    if (phase === undefined)
        phase = 0;
    return (sample, rate, centerFreq, I, Q) => {
        const delta = (freq - centerFreq) / rate;
        if (delta >= 0.5 || -0.5 >= delta) {
            I.fill(0);
            Q.fill(0);
            return;
        }
        const p = 2 * Math.PI * delta * (sample % rate) + phase;
        let a = Math.cos(p);
        let b = Math.sin(p);
        const f = 2 * Math.PI * delta;
        const c = Math.cos(f);
        const d = Math.sin(f);
        for (let i = 0; i < I.length; ++i) {
            I[i] = a * amplitude;
            Q[i] = b * amplitude;
            const xa = a * c - b * d;
            const xb = b * c + a * d;
            a = xa;
            b = xb;
        }
    };
}
/** Returns a generator for noise with a given maximum amplitude. */
export function noise(amplitude, random) {
    if (random === undefined)
        random = Math.random;
    return (_sample, _rate, _centerFreq, I, Q) => {
        for (let i = 0; i < I.length; ++i) {
            let r = amplitude * Math.sqrt(random());
            let t = random() * 2 * Math.PI;
            I[i] = r * Math.cos(t);
            Q[i] = r * Math.sin(t);
        }
    };
}
/** Returns a generator that adds the outputs of all the provided generators together. */
export function sum(...generators) {
    let pool = new IqPool(1, 65536);
    return (sample, rate, centerFreq, I, Q) => {
        I.fill(0);
        Q.fill(0);
        let [J, R] = pool.get(I.length);
        for (let g of generators) {
            g(sample, rate, centerFreq, J, R);
            for (let i = 0; i < I.length; ++i) {
                I[i] += J[i];
                Q[i] += R[i];
            }
        }
    };
}
/**
 * Returns a generator that multiplies the output of the carrier generator
 * with the output of the signal generator.
 * The signal generator always receives a center frequency of 0 Hz.
 */
export function product(carrier, signal) {
    let pool = new IqPool(1, 65536);
    return (sample, rate, centerFreq, I, Q) => {
        let [J, R] = pool.get(I.length);
        carrier(sample, rate, centerFreq, I, Q);
        signal(sample, rate, 0, J, R);
        for (let i = 0; i < I.length; ++i) {
            const a = I[i];
            const b = Q[i];
            const c = J[i];
            const d = R[i];
            I[i] = a * c - b * d;
            Q[i] = a * d + b * c;
        }
    };
}
/**
 * Returns a generator that multiplies every sample by the given gain.
 */
export function amplify(gain, signal) {
    return (sample, rate, centerFreq, I, Q) => {
        signal(sample, rate, centerFreq, I, Q);
        for (let i = 0; i < I.length; ++i) {
            I[i] *= gain;
            Q[i] *= gain;
        }
    };
}
/** Returns the real part of another generator's output. */
export function real(signal) {
    return (sample, rate, centerFreq, I, Q) => {
        signal(sample, rate, centerFreq, I, Q);
        Q.fill(0);
    };
}
/**
 * Returns a generator that amplitude-modulates the output
 * of the signal generator using a modulation factor of 2.
 * Only the I component of the signal is used as the input.
 * The signal generator always receives a center frequency of 0 Hz.
 */
export function modulateAM(carrierFreq, amplitude, signal) {
    let pool = new IqPool(1, 65536);
    const carrier = tone(carrierFreq, amplitude);
    return (sample, rate, centerFreq, I, Q) => {
        const delta = (carrierFreq - centerFreq) / rate;
        if (delta >= 0.5 || -0.5 >= delta) {
            I.fill(0);
            Q.fill(0);
            return;
        }
        let [J, R] = pool.get(I.length);
        carrier(sample, rate, centerFreq, I, Q);
        signal(sample, rate, 0, J, R);
        for (let i = 0; i < I.length; ++i) {
            const c = (1 + J[i]) / 2;
            I[i] *= c;
            Q[i] *= c;
        }
    };
}
/**
 * Returns a generator that frequency-modulates the output
 * of the signal generator using the given maximum frequency deviation.
 * Only the I component of the signal is used as the input.
 * The signal generator always receives a center frequency of 0 Hz.
 */
export function modulateFM(carrierFreq, maximumDeviation, amplitude, signal) {
    let pool = new IqPool(1, 65536);
    let phase = 0;
    return (sample, rate, centerFreq, I, Q) => {
        const delta = (carrierFreq - centerFreq) / rate;
        if (delta >= 0.5 || -0.5 >= delta) {
            I.fill(0);
            Q.fill(0);
            return;
        }
        const maxF = maximumDeviation / rate;
        let [J, R] = pool.get(I.length);
        signal(sample, rate, 0, J, R);
        let sigSum = 0;
        let p = phase;
        for (let i = 0; i < I.length; ++i) {
            const angle = 2 * Math.PI * p;
            I[i] = amplitude * Math.cos(angle);
            Q[i] = amplitude * Math.sin(angle);
            p += delta + maxF * J[i];
            sigSum += J[i];
        }
        phase += delta * I.length + maxF * sigSum;
        phase -= Math.floor(phase);
    };
}
/**
 * Returns a generator that applies pre-emphasis to the output of another signal generator.
 * This pre-emphasis is just the opposite to the de-emphasis produced by an IIR single-pole
 * low-pass filter with the given time constant.
 */
function preemphasis(tcMicros, signal) {
    let prevRate;
    let filterI;
    let filterQ;
    return (sample, rate, centerFreq, I, Q) => {
        if (prevRate !== rate) {
            prevRate = rate;
            filterI = new Preemphasis(rate, tcMicros / 1e6);
            filterQ = filterI.clone();
        }
        signal(sample, rate, centerFreq, I, Q);
        filterI.inPlace(I);
        filterQ.inPlace(Q);
    };
}
/**
 * Returns a generator that avoids recomputing the signal
 * if called twice with the same parameters.
 */
function cache(signal) {
    let lastSample;
    let lastRate;
    let lastCenterFreq;
    let pool = new IqPool(1, 1024);
    let cache = [
        new Float32Array(0),
        new Float32Array(0),
    ];
    return (sample, rate, centerFreq, I, Q) => {
        if (lastSample !== sample ||
            lastRate !== rate ||
            lastCenterFreq !== centerFreq ||
            cache[0].length !== I.length) {
            cache = pool.get(I.length);
            signal(sample, rate, centerFreq, cache[0], cache[1]);
            lastSample = sample;
            lastRate = rate;
            lastCenterFreq = centerFreq;
        }
        I.set(cache[0]);
        Q.set(cache[1]);
    };
}
export function wbfmSignal(left, rightOrTcMicros, tcMicros) {
    let right;
    if (typeof rightOrTcMicros === "number") {
        tcMicros = rightOrTcMicros;
    }
    else {
        right = rightOrTcMicros;
    }
    if (tcMicros === undefined)
        tcMicros = 50;
    if (right === undefined)
        return amplify(0.9, preemphasis(tcMicros, real(left)));
    const pilot = real(tone(19000, 0.1, -Math.PI / 2));
    const shift = real(tone(38000, 1, -Math.PI / 2));
    const l = cache(preemphasis(tcMicros, real(left)));
    const r = cache(preemphasis(tcMicros, real(right)));
    const apb = amplify(0.45, sum(l, r));
    const amb = amplify(0.45, sum(l, amplify(-1, r)));
    return sum(apb, pilot, product(amb, shift));
}
/** Returns a generator that quantizes a generated signal with the given number of bits. */
export function quantized(signal, bits) {
    return (firstSample, sampleRate, centerFrequency, I, Q) => {
        signal(firstSample, sampleRate, centerFrequency, I, Q);
        const f = (1 << bits) - 1;
        for (let i = 0; i < I.length; ++i) {
            I[i] = (2 * Math.round(((I[i] + 1) * f) / 2)) / f - 1;
            Q[i] = (2 * Math.round(((Q[i] + 1) * f) / 2)) / f - 1;
        }
    };
}
