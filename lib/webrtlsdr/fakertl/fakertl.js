// Copyright 2026 Jacobo Tarrio Barreiro. All rights reserved.
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
import { GeneratedSource, } from "../../signals/sources/generated.js";
import { U8Pool } from "../../signals/dsp/buffers.js";
import { DirectSampling, } from "../rtlsdr.js";
/** A provider for fake RTL-SDR devices. */
export class FakeRtlDeviceProvider {
    generator;
    /**
     * @param generator A SampleGenerator that returns the signals for the fake RTL-SDR device.
     */
    constructor(generator) {
        this.generator = generator;
    }
    async get() {
        return new FakeRtlDevice(this.generator);
    }
}
/** A class that can be used to test without using a real RTL-SDR device. */
export class FakeRtlDevice {
    constructor(generator) {
        this.gain = null;
        this.gainMultiplier = 1;
        this.ppm = 0;
        this.directSamplingMethod = DirectSampling.Off;
        this.biasTee = false;
        this.source = new GeneratedSource(this.adaptSource(generator));
        this.source.setSampleRate(1024000);
        this.pool = new U8Pool(8);
    }
    source;
    pool;
    gain;
    gainMultiplier;
    ppm;
    directSamplingMethod;
    biasTee;
    setSampleRate(rate) {
        return this.source.setSampleRate(Math.floor(rate));
    }
    async setCenterFrequency(freq) {
        return this.source.setCenterFrequency(freq);
    }
    async setGain(gain) {
        this.gain = gain;
        if (gain != null) {
            this.gainMultiplier = Math.pow(10, (gain - 25) / 20);
        }
    }
    getGain() {
        return this.gain;
    }
    async setFrequencyCorrection(ppm) {
        this.ppm = Math.floor(ppm);
    }
    getFrequencyCorrection() {
        return this.ppm;
    }
    async setDirectSamplingMethod(method) {
        this.directSamplingMethod = method;
    }
    getDirectSamplingMethod() {
        return this.directSamplingMethod;
    }
    async enableBiasTee(enable) {
        this.biasTee = enable;
    }
    isBiasTeeEnabled() {
        return this.biasTee;
    }
    resetBuffer() {
        return this.source.startReceiving();
    }
    async readSamples(length) {
        let output = await this.source.readSamples(length);
        let data = this.pool.get(output.I.length * 2);
        for (let i = 0; i < output.I.length; ++i) {
            data[2 * i] = output.I[i];
            data[2 * i + 1] = output.Q[i];
        }
        return {
            frequency: output.frequency,
            data: data.buffer,
            directSampling: false,
        };
    }
    close() {
        return this.source.close();
    }
    adaptSource(generator) {
        return (firstSample, sampleRate, centerFrequency, I, Q) => {
            centerFrequency = centerFrequency * (1 + this.ppm / 1e6);
            generator(firstSample, sampleRate, centerFrequency, I, Q);
            if (this.gain !== null) {
                let mul = this.gainMultiplier;
                for (let i = 0; i < I.length; ++i) {
                    I[i] = Math.max(-1, Math.min(I[i] * mul, 1));
                    Q[i] = Math.max(-1, Math.min(Q[i] * mul, 1));
                }
            }
            for (let i = 0; i < I.length; ++i) {
                I[i] = Math.round(((I[i] + 1) * 255) / 2);
                Q[i] = Math.round(((Q[i] + 1) * 255) / 2);
            }
        };
    }
}
