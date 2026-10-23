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
import { Float32Pool } from "../dsp/buffers.js";
import { makeLowPassKernel } from "../dsp/coefficients.js";
import { AGC, FrequencyShifter, IqFFTFilter, IqFIRFilter, } from "../dsp/filters.js";
import { getPower } from "../dsp/power.js";
import { getIqResampler } from "../dsp/resamplers.js";
import { Configurator } from "./modes.js";
/** A demodulator for continuous wave signals. */
export class DemodCW {
    outRate;
    mode;
    /**
     * @param inRate The sample rate of the input samples.
     * @param outRate The sample rate of the output audio.
     * @param mode The mode to use initially.
     * @param options Options for the demodulator.
     */
    constructor(inRate, outRate, mode, options) {
        this.outRate = outRate;
        this.mode = mode;
        const downsamplerTaps = options?.downsamplerTaps || 151;
        this.audioTaps = options?.audioTaps || 351;
        const toneFrequency = options?.toneFrequency || 600;
        this.shifter = new FrequencyShifter(inRate);
        this.downsampler = getIqResampler(inRate, outRate, {
            legacyTaps: downsamplerTaps,
        });
        const kernel = makeLowPassKernel(outRate, mode.bandwidth / 2, this.audioTaps);
        this.filter = options?.useFftFilter
            ? new IqFFTFilter(kernel)
            : new IqFIRFilter(kernel);
        this.toneShifter = new FrequencyShifter(outRate);
        this.toneFrequency = toneFrequency;
        this.agc = new AGC(outRate, 10);
        this.outPool = new Float32Pool(1);
    }
    audioTaps;
    shifter;
    downsampler;
    filter;
    toneShifter;
    toneFrequency;
    agc;
    outPool;
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
        const kernel = makeLowPassKernel(this.outRate, mode.bandwidth / 2, this.audioTaps);
        this.filter.setCoefficients(kernel);
    }
    /** Demodulates the given I/Q samples into the real output. */
    demodulate(samplesI, samplesQ, freqOffset) {
        this.shifter.inPlace(samplesI, samplesQ, -freqOffset);
        const [I, Q] = this.downsampler.resample(samplesI, samplesQ);
        let allPower = getPower(I, Q);
        this.filter.inPlace(I, Q);
        let signalPower = (getPower(I, Q) * this.outRate) / this.mode.bandwidth;
        this.toneShifter.inPlace(I, Q, this.toneFrequency);
        this.agc.inPlace(I);
        let right = this.outPool.get(I.length);
        right.set(I);
        return {
            left: I,
            right,
            stereo: false,
            snr: signalPower / allPower,
        };
    }
}
/** Configurator for the CW mode. */
export class ConfigCW extends Configurator {
    constructor(mode) {
        super(mode);
    }
    create() {
        return { scheme: "CW", bandwidth: 50 };
    }
    hasBandwidth() {
        return true;
    }
    getBandwidth() {
        return this.mode.bandwidth;
    }
    setBandwidth(bandwidth) {
        this.mode = {
            ...this.mode,
            bandwidth: Math.max(5, Math.min(bandwidth, 1000)),
        };
        return this;
    }
}
