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
/** State machine to orchestrate the RTL2832, demodulation, and audio playing. */
import { Radio as BaseRadio, } from "../../signals/radio.js";
import { DirectSampling } from "../rtlsdr/rtldevice.js";
/** The type of 'radio' events. */
export class RadioEvent extends CustomEvent {
    constructor(e) {
        super("radio", { detail: e });
    }
}
/** Provides controls to play, stop, and tune the radio. */
export class Radio extends BaseRadio {
    /**
     * Creates an instance of Radio.
     *
     * Since this constructor sends commands, you should call `ready()` before using the radio.
     *
     * @param rtlProvider a RtlSignalSourceProvider instance.
     * @param sampleReceiver the object that will receive the signals from the RTL source.
     * @param options options for the radio.
     */
    constructor(rtlProvider, sampleReceiver, options) {
        super(rtlProvider, sampleReceiver, options);
        this.directSampling = false;
        this.setFrequencyCorrection(0);
        this.setGain(null);
        this.setFrequency(88500000);
        this.setDirectSamplingMethod(DirectSampling.Off);
        this.enableBiasTee(false);
    }
    directSampling;
    /** Sets the frequency correction factor, in PPM. */
    async setFrequencyCorrection(ppm) {
        return this.setParameter("frequency_correction", ppm);
    }
    /** Returns the current frequency correction factor. */
    getFrequencyCorrection() {
        return this.getParameter("frequency_correction");
    }
    /**
     * Sets the RF gain.
     * @param gain the gain in dB, or null for automatic gain control.
     */
    async setGain(gain) {
        return this.setParameter("gain", gain);
    }
    /**
     * Returns the RF gain.
     * @returns the gain in dB, or null for automatic gain control.
     */
    getGain() {
        return this.getParameter("gain");
    }
    /** Sets the direct sampling method. */
    async setDirectSamplingMethod(method) {
        return this.setParameter("direct_sampling_method", method);
    }
    /** Returns the current direct sampling method. */
    getDirectSamplingMethod() {
        return this.getParameter("direct_sampling_method");
    }
    /** Enables or disables the bias tee. */
    async enableBiasTee(enable) {
        return this.setParameter("bias_tee", enable);
    }
    /** Returns whether the bias tee is enabled. */
    isBiasTeeEnabled() {
        return this.getParameter("bias_tee");
    }
    onReceiveSamples(block) {
        let directSampling = block.data?.directSampling || false;
        if (directSampling == this.directSampling)
            return;
        this.directSampling = directSampling;
        this.dispatchEvent(new RadioEvent({
            type: "directSampling",
            active: this.directSampling,
        }));
    }
    addEventListener(type, callback, options) {
        super.addEventListener(type, callback, options);
    }
}
