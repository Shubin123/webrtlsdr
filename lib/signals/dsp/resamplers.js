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
import { RadioError, RadioErrorType } from "../errors.js";
import { Float32Pool } from "./buffers.js";
import { makeLowPassKernel } from "./coefficients.js";
import { BaseWasmFirFilter } from "./filters.js";
class Downsampler {
    ratio;
    constructor(ratio, kernel) {
        this.ratio = ratio;
        if (ratio != Math.floor(ratio))
            throw new RadioError(`Non-integer downsample ratio: ${ratio}`, RadioErrorType.DemodulationError);
        this.filter = new DownsamplingFilter(kernel);
        this.pool = new Float32Pool(2);
        this.residual = 0;
    }
    filter;
    pool;
    residual;
    resample(samples) {
        const ratio = this.ratio;
        const skip = (ratio - this.residual) % ratio;
        const outLen = Math.floor((this.residual + samples.length - 1) / ratio) -
            Math.floor((this.residual - 1) / ratio);
        let output = this.pool.get(outLen);
        output.set(this.filter.filter(samples, outLen, ratio, skip));
        this.residual = (this.residual + samples.length) % ratio;
        return output;
    }
    getDelay() {
        return this.filter.getDelay() / this.ratio;
    }
    clone() {
        let out = new Downsampler(this.ratio, new Float32Array(1));
        out.filter = this.filter.clone();
        return out;
    }
}
class Upsampler {
    ratio;
    constructor(ratio, kernel) {
        this.ratio = ratio;
        if (ratio != Math.floor(ratio))
            throw new RadioError(`Non-integer upsample ratio: ${ratio}`, RadioErrorType.DemodulationError);
        this.filter = new UpsamplingFilter(kernel, ratio);
        this.pool = new Float32Pool(2);
    }
    filter;
    pool;
    resample(samples) {
        const ratio = this.ratio;
        const outLen = samples.length * ratio;
        let output = this.pool.get(outLen);
        output.set(this.filter.filter(samples));
        return output;
    }
    getDelay() {
        return this.filter.getDelay();
    }
    clone() {
        let out = new Upsampler(this.ratio, new Float32Array(this.ratio));
        out.filter = this.filter.clone();
        return out;
    }
}
class Resampler {
    upRatio;
    downRatio;
    constructor(upRatio, downRatio, kernel) {
        this.upRatio = upRatio;
        this.downRatio = downRatio;
        if (upRatio != Math.floor(upRatio))
            throw new RadioError(`Non-integer upsample ratio: ${upRatio}`, RadioErrorType.DemodulationError);
        if (downRatio != Math.floor(downRatio))
            throw new RadioError(`Non-integer downsample ratio: ${downRatio}`, RadioErrorType.DemodulationError);
        this.filter = new UpsamplingFilter(kernel, upRatio);
        this.pool = new Float32Pool(2);
        this.residual = 0;
    }
    filter;
    pool;
    residual;
    resample(samples) {
        const upRatio = this.upRatio;
        const downRatio = this.downRatio;
        const skip = (downRatio - this.residual) % downRatio;
        const midLen = samples.length * upRatio;
        const outLen = Math.floor((this.residual + midLen - 1) / downRatio) -
            Math.floor((this.residual - 1) / downRatio);
        let output = this.pool.get(outLen);
        output.set(this.filter.filterWithStride(samples, outLen, downRatio, skip));
        this.residual = (this.residual + midLen) % downRatio;
        return output;
    }
    getDelay() {
        return this.filter.getDelay() / this.downRatio;
    }
    clone() {
        let out = new Resampler(this.upRatio, this.downRatio, new Float32Array(this.upRatio));
        out.filter = this.filter.clone();
        return out;
    }
}
class GenericIqResampler {
    constructor(realResampler) {
        this.resampleI = realResampler.clone();
        this.resampleQ = realResampler.clone();
    }
    resampleI;
    resampleQ;
    resample(I, Q) {
        return [this.resampleI.resample(I), this.resampleQ.resample(Q)];
    }
    getDelay() {
        return this.resampleI.getDelay();
    }
    clone() {
        return new GenericIqResampler(this.resampleI);
    }
}
/** Returns a RealResampler that converts signals from the input rate to the output rate. */
export function getRealResampler(inRate, outRate, options) {
    if (inRate > outRate && inRate % outRate == 0) {
        // Pure downsampler
        let downFactor = inRate / outRate;
        let corner = options?.lowPassFrequency || outRate / 2;
        let taps = options?.legacyTaps
            ? options?.legacyTaps
            : (options?.taps || 41) * downFactor;
        let gain = options?.gain;
        let kernel = options?.kernel || makeLowPassKernel(inRate, corner, taps, gain);
        return new Downsampler(inRate / outRate, kernel);
    }
    if (inRate < outRate && outRate % inRate == 0) {
        // Pure upsampler
        let upFactor = outRate / inRate;
        let corner = options?.lowPassFrequency || inRate / 2;
        let taps = options?.legacyTaps
            ? Math.round((options?.legacyTaps * outRate) / inRate)
            : options?.taps || 41;
        let gain = options?.gain;
        let kernel = options?.kernel || makeLowPassKernel(outRate, corner, taps, gain);
        return new Upsampler(upFactor, kernel);
    }
    // Resampler
    let gcd = greatestCommonDivisor(inRate, outRate);
    let upFactor = outRate / gcd;
    let downFactor = inRate / gcd;
    let interRate = (inRate * outRate) / gcd;
    let corner = options?.lowPassFrequency || Math.min(inRate, outRate) / 2;
    let taps = options?.legacyTaps
        ? Math.round((options?.legacyTaps * outRate) / gcd)
        : (options?.taps || 41) * downFactor;
    let gain = options?.gain;
    let kernel = options?.kernel || makeLowPassKernel(interRate, corner, taps, gain);
    return new Resampler(upFactor, downFactor, kernel);
}
/** Returns an IqResampler that converts signals from the input rate to the output rate. */
export function getIqResampler(inRate, outRate, options) {
    return new GenericIqResampler(getRealResampler(inRate, outRate, options));
}
/**
 * Computes an output sample rate that makes for the simplest rescaler.
 *
 * For example, to resample 1024000 to 336000 samples/sec,
 * the resampler has to upsample 21x and then downsample 64x.
 * However, with a tolerance of 50000 samples/sec, you could instead
 * resample to 384000 samples/sec, which only requires upsampling 3x and downsampling 8x.
 *
 * @param inRate The input sample rate.
 * @param outRate The desired output sample rate.
 * @param tolerance The variation that's allowed for the sample rate (over or under the outRate).
 * @returns The computed sample rate.
 */
export function getGoodResampleRate(inRate, outRate, tolerance) {
    if (inRate == outRate)
        return inRate;
    let left = outRate - tolerance;
    let right = outRate + tolerance;
    if (left <= inRate && inRate <= right)
        return inRate;
    if (inRate > outRate) {
        for (let d = 2;; ++d) {
            let best = -1;
            let bestDist = outRate;
            const minM = Math.ceil((left * d) / inRate);
            const maxM = Math.floor((right * d) / inRate);
            for (let m = minM; m <= maxM; ++m) {
                let target = (inRate * m) / d;
                if (Number.isInteger(target)) {
                    let dist = Math.abs(target - outRate);
                    if (dist < bestDist || best < 0) {
                        best = target;
                        bestDist = dist;
                    }
                }
            }
            if (best > 0)
                return best;
        }
    }
    for (let m = 2;; ++m) {
        let best = -1;
        let bestDist = outRate;
        const minD = Math.ceil((m * inRate) / right);
        const maxD = Math.floor((m * inRate) / left);
        for (let d = minD; d <= maxD; ++d) {
            let target = (inRate * m) / d;
            if (Number.isInteger(target)) {
                let dist = Math.abs(target - outRate);
                if (dist < bestDist || best < 0) {
                    best = target;
                    bestDist = dist;
                }
            }
        }
        if (best > 0)
            return best;
    }
}
function greatestCommonDivisor(a, b) {
    if (a < b) {
        [a, b] = [b, a];
    }
    while (b != 0) {
        [a, b] = [b, a % b];
    }
    return a;
}
function splitKernel(kernel, ratio) {
    let delay = Math.floor(kernel.length / 2);
    if (kernel.length % ratio != 0) {
        const wantedLen = ratio * Math.ceil(kernel.length / ratio);
        const newKernel = new Float32Array(wantedLen);
        newKernel.subarray(wantedLen - kernel.length, wantedLen).set(kernel);
        kernel = newKernel;
    }
    const coefLen = kernel.length / ratio;
    let coefs = [];
    for (let i = 0; i < ratio; ++i) {
        const filterKernel = new Float32Array(coefLen);
        for (let j = 0; j < coefLen; ++j) {
            filterKernel[j] = kernel[(j + 1) * ratio - i - 1] * ratio;
        }
        coefs[i] = filterKernel;
    }
    return { delay, coefs };
}
/** A specialized filter for downsampling. */
class DownsamplingFilter extends BaseWasmFirFilter {
    coefs;
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
        return new DownsamplingFilter(this.coefs);
    }
    getDelay() {
        return this.delay;
    }
    filter(samples, num, stride, offset) {
        this.loadSamples(samples);
        return this.convolver.convolveWithStride(this.curSamples, num, stride, offset);
    }
}
/** A specialized filter for upsampling and resampling. */
class UpsamplingFilter extends BaseWasmFirFilter {
    kernel;
    ratio;
    constructor(kernel, ratio) {
        const { delay, coefs } = splitKernel(kernel, ratio);
        super(coefs[0].length - 1, delay);
        this.kernel = kernel;
        this.ratio = ratio;
        this.convolver.setCoefArray(coefs);
    }
    clone() {
        return new UpsamplingFilter(this.kernel, this.ratio);
    }
    filter(samples) {
        this.loadSamples(samples);
        return this.convolver.convolveExpanding(this.curSamples, samples.length, this.ratio);
    }
    filterWithStride(samples, num, stride, offset) {
        this.loadSamples(samples);
        return this.convolver.convolveExpandingWithStride(this.curSamples, num, stride, offset);
    }
}
