// Copyright 2026 Jacobo Tarrio Barreiro. All rights reserved.
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
import { Float32Pool } from "../dsp/buffers.js";
import { makeLowPassKernel } from "../dsp/coefficients.js";
import { FMDemodulator, StereoSeparator } from "../dsp/demodulators.js";
import { Deemphasis, FrequencyShifter, IqFFTFilter, IqFIRFilter, } from "../dsp/filters.js";
import { getPower } from "../dsp/power.js";
import { getIqResampler, getRealResampler, } from "../dsp/resamplers.js";
import { Configurator } from "./modes.js";
/** A demodulator for wideband FM signals. */
export class DemodWBFM {
    mode;
    /**
     * @param inRate The sample rate of the input samples.
     * @param outRate The sample rate of the output samples.
     * @param mode The mode to use initially.
     * @param options Options for the demodulator.
     */
    constructor(inRate, outRate, mode, options) {
        this.mode = mode;
        let interRate = Math.min(inRate, 336000);
        this.stage1 = new DemodWBFMStage1(inRate, interRate, mode, options);
        this.stage2 = new DemodWBFMStage2(interRate, outRate, mode, options);
    }
    stage1;
    stage2;
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
        this.stage1.setMode(mode);
        this.stage2.setMode(mode);
    }
    /**
     * Demodulates the signal.
     * @param samplesI The I components of the samples.
     * @param samplesQ The Q components of the samples.
     * @param freqOffset The offset of the signal in the samples.
     * @returns The demodulated audio signal.
     */
    demodulate(samplesI, samplesQ, freqOffset) {
        let o1 = this.stage1.demodulate(samplesI, samplesQ, freqOffset);
        let o2 = this.stage2.demodulate(o1.left);
        o2.snr = o1.snr;
        return o2;
    }
}
/**
 * First stage demodulator for wideband FM signals.
 * Returns the raw demodulated FM signal, with stereo pilot, difference signal and RDS, if they exist.
 * The output is duplicated in the left and right channels.
 */
export class DemodWBFMStage1 {
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
        const maxF = 75000;
        const downsamplerTaps = options?.downsamplerTaps || 151;
        const rfTaps = options?.rfTaps || 151;
        this.shifter = new FrequencyShifter(inRate);
        if (inRate != outRate) {
            this.downsampler = getIqResampler(inRate, outRate, {
                legacyTaps: downsamplerTaps,
            });
        }
        const kernel = makeLowPassKernel(outRate, maxF, rfTaps);
        this.filter = options?.useFftFilter
            ? new IqFFTFilter(kernel)
            : new IqFIRFilter(kernel);
        this.demodulator = new FMDemodulator(maxF / outRate);
    }
    shifter;
    downsampler;
    filter;
    demodulator;
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
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
        let [I, Q] = this.downsampler
            ? this.downsampler.resample(samplesI, samplesQ)
            : [samplesI, samplesQ];
        let allPower = getPower(I, Q);
        this.filter.inPlace(I, Q);
        let signalPower = (getPower(I, Q) * this.outRate) / 150000;
        this.demodulator.demodulate(I, Q, I);
        return {
            left: I,
            right: new Float32Array(I),
            stereo: false,
            snr: signalPower / allPower,
        };
    }
}
/**
 * Second stage demodulator for wideband FM signals.
 * Takes the output of stage 1 and does stereo extraction.
 * Only the I channel is used; Q channel is ignored.
 * */
export class DemodWBFMStage2 {
    mode;
    /**
     * @param inRate The sample rate of the input samples.
     * @param outRate The sample rate of the output audio.
     * @param mode The mode to use initially.
     * @param options Options for the demodulator.
     */
    constructor(inRate, outRate, mode, options) {
        this.mode = mode;
        const pilotF = 19000;
        const deemphTc = (options?.deemphasizerTc === undefined ? 50 : options.deemphasizerTc) /
            1e6;
        const audioTaps = options?.audioTaps || 41;
        const filterF = Math.min(15000, outRate / 2);
        this.monoSampler = getRealResampler(inRate, outRate, {
            lowPassFrequency: filterF,
            legacyTaps: audioTaps,
            gain: 1 / 0.9,
        });
        this.stereoSampler = this.monoSampler.clone();
        this.stereoSeparator = new StereoSeparator(inRate, pilotF);
        this.leftDeemph = new Deemphasis(outRate, deemphTc);
        this.rightDeemph = new Deemphasis(outRate, deemphTc);
        this.outPool = new Float32Pool(2, 1024);
    }
    monoSampler;
    stereoSampler;
    stereoSeparator;
    leftDeemph;
    rightDeemph;
    outPool;
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
    }
    /**
     * Demodulates the signal.
     * @param samplesI The I components of the samples.
     * @returns The demodulated audio signal.
     */
    demodulate(samplesI) {
        let audio = this.monoSampler.resample(samplesI);
        if (this.mode.stereo) {
            const stereo = this.stereoSeparator.separate(samplesI);
            if (stereo.found) {
                const diffAudio = this.stereoSampler.resample(stereo.diff);
                let leftAudio = this.outPool.get(audio.length);
                let rightAudio = audio;
                for (let i = 0; i < diffAudio.length; ++i) {
                    leftAudio[i] = audio[i] - diffAudio[i];
                    rightAudio[i] = audio[i] + diffAudio[i];
                }
                this.leftDeemph.inPlace(leftAudio);
                this.rightDeemph.inPlace(rightAudio);
                return {
                    left: leftAudio,
                    right: rightAudio,
                    stereo: true,
                    snr: 1,
                };
            }
        }
        this.leftDeemph.inPlace(audio);
        let right = this.outPool.get(audio.length);
        right.set(audio);
        return {
            left: audio,
            right,
            stereo: false,
            snr: 1,
        };
    }
}
/** Configurator for the WBFM mode. */
export class ConfigWBFM extends Configurator {
    constructor(mode) {
        super(mode);
    }
    create() {
        return { scheme: "WBFM", stereo: true };
    }
    hasStereo() {
        return true;
    }
    getStereo() {
        return this.mode.stereo;
    }
    setStereo(stereo) {
        this.mode = { ...this.mode, stereo: stereo };
        return this;
    }
    getBandwidth() {
        return 150000;
    }
}
