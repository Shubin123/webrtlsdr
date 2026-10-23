// Copyright 2026 Jacobo Tarrio Barreiro. All rights reserved.
// Copyright 2014 Google Inc. All rights reserved.
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
import { Sideband, SSBDemodulator } from "../dsp/demodulators.js";
import { FrequencyShifter, AGC, FIRFilter, FFTFilter } from "../dsp/filters.js";
import { getPower } from "../dsp/power.js";
import { getIqResampler } from "../dsp/resamplers.js";
import { Configurator } from "./modes.js";
/** A demodulator for single-sideband modulated signals. */
export class DemodSSB {
    outRate;
    mode;
    /**
     * @param inRate The sample rate of the input samples.
     * @param outRate The sample rate of the output audio.
     * @param mode The mode to use initially.
     */
    constructor(inRate, outRate, mode, options) {
        this.outRate = outRate;
        this.mode = mode;
        const downsamplerTaps = options?.downsamplerTaps || 151;
        this.rfTaps = options?.rfTaps || 151;
        const hilbertTaps = options?.hilbertTaps || 351;
        this.shifter = new FrequencyShifter(inRate);
        this.downsampler = getIqResampler(inRate, outRate, {
            legacyTaps: downsamplerTaps,
        });
        const kernel = makeLowPassKernel(this.outRate, mode.bandwidth, this.rfTaps);
        this.filter = options?.useFftFilter
            ? new FFTFilter(kernel)
            : new FIRFilter(kernel);
        this.demodulator = new SSBDemodulator(mode.scheme == "USB" ? Sideband.Upper : Sideband.Lower, hilbertTaps, { useFftFilter: options?.useFftFilter });
        this.agc = new AGC(outRate, 3);
        this.outPool = new Float32Pool(1);
    }
    rfTaps;
    shifter;
    downsampler;
    filter;
    demodulator;
    agc;
    outPool;
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
        const kernel = makeLowPassKernel(this.outRate, mode.bandwidth, this.rfTaps);
        this.filter.setCoefficients(kernel);
        this.demodulator.setSideband(mode.scheme == "USB" ? Sideband.Upper : Sideband.Lower);
    }
    /**
     * Demodulates the signal.
     * @param samplesI The I components of the samples.
     * @param samplesQ The Q components of the samples.
     * @param freqOffset The offset of the signal in the samples.
     * @returns The demodulated audio signal.
     */
    demodulate(samplesI, samplesQ, freqOffset) {
        this.shifter.inPlace(samplesI, samplesQ, -freqOffset);
        const [I, Q] = this.downsampler.resample(samplesI, samplesQ);
        let allPower = getPower(I, Q);
        this.demodulator.demodulate(I, Q, I);
        this.filter.inPlace(I);
        let signalPower = (getPower(I, I) * this.outRate) / this.mode.bandwidth;
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
/** Configurator for the USB and LSB modes. */
export class ConfigSSB extends Configurator {
    constructor(mode) {
        super(mode);
    }
    create(scheme) {
        return { scheme: scheme, bandwidth: 2800, squelch: 0 };
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
            bandwidth: Math.max(10, Math.min(bandwidth, 15000)),
        };
        return this;
    }
    hasSquelch() {
        return true;
    }
    getSquelch() {
        return this.mode.squelch;
    }
    setSquelch(squelch) {
        this.mode = { ...this.mode, squelch: Math.max(0, Math.min(squelch, 6)) };
        return this;
    }
}
