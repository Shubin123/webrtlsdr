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
import { U8ToFloat32 } from "../../signals/dsp/converters.js";
import { RTL2832U_Provider } from "../rtlsdr.js";
/** SignalSource that reads from an RTL-SDR device. */
export class RtlSource {
    rtl;
    constructor(rtl) {
        this.rtl = rtl;
        this.converter = new U8ToFloat32();
    }
    converter;
    async setSampleRate(sampleRate) {
        await this.rtl.setSampleRate(sampleRate);
        return sampleRate;
    }
    async setCenterFrequency(freq) {
        await this.rtl.setCenterFrequency(freq);
        return freq;
    }
    async setParameter(parameter, value) {
        switch (parameter) {
            case "bias_tee":
                await this.rtl.enableBiasTee(value);
                return value;
            case "direct_sampling_method":
                await this.rtl.setDirectSamplingMethod(value);
                return value;
            case "frequency_correction":
                await this.rtl.setFrequencyCorrection(value);
                return value;
            case "gain":
                await this.rtl.setGain(value);
                return value;
        }
    }
    startReceiving() {
        return this.rtl.resetBuffer();
    }
    async readSamples(length) {
        let block = await this.rtl.readSamples(length);
        let iq = this.converter.convert(block.data);
        return {
            I: iq[0],
            Q: iq[1],
            frequency: block.frequency,
            data: { directSampling: block.directSampling },
        };
    }
    close() {
        return this.rtl.close();
    }
}
/** SignalSourceProvider that creates a source from the device returned by an RtlDeviceProvider. */
export class RtlProvider {
    constructor(provider) {
        this.provider = provider || new RTL2832U_Provider();
    }
    provider;
    async get() {
        return new RtlSource(await this.provider.get());
    }
}
