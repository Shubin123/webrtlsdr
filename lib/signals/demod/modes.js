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
 * Registers a modulation scheme. If a modulation scheme by that name already exists, it is replaced.
 * @param name the name of the modulation scheme. Must match the content of `scheme` in the mode.
 * @param demod the constructor of the Demod class.
 * @param config the constructor of the Configurator class.
 */
export function registerDemod(name, demod, config) {
    registeredDemods.set(name, { demod: demod, config: config });
}
/** Unregisters a modulation scheme. */
export function unregisterDemod(name) {
    registeredDemods.delete(name);
}
/** Returns the list of registered modulation schemes, in the order in which they were registered. */
export function getSchemes() {
    return [...registeredDemods.keys()];
}
/** Returns the default mode for the given scheme name. */
export function getMode(scheme) {
    let reg = getRegisteredDemod(scheme);
    return new reg.config(scheme).mode;
}
/**
 * Returns a Scheme object for the given mode.
 * @param inRate the rate of the samples received by the demodulator.
 * @param outRate the rate of the samples output by the demodulator.
 * @param mode mode parameters (bandwidth, squelch, etc.)
 * @param options options for the demodulator.
 */
export function getDemod(inRate, outRate, mode, options) {
    let reg = getRegisteredDemod(mode);
    return new reg.demod(inRate, outRate, mode, options);
}
export function modeParameters(mode) {
    let reg = getRegisteredDemod(mode);
    return new reg.config(mode);
}
/** A base for classes that inspect and modify a mode parameters object. */
export class Configurator {
    base;
    constructor(base) {
        this.base = base;
    }
    get mode() {
        if (typeof this.base === "string") {
            this.base = this.create(this.base);
        }
        return this.base;
    }
    set mode(mode) {
        this.base = mode;
    }
    /** Returns whether stereo output is settable in this mode. */
    hasStereo() {
        return false;
    }
    /** Returns whether stereo output is enabled. */
    getStereo() {
        return false;
    }
    /** Enables or disables stereo output. */
    setStereo(stereo) {
        return this;
    }
    /** Returns whether the bandwidth is settable in this mode. */
    hasBandwidth() {
        return false;
    }
    /** Changes the bandwidth used by this mode. */
    setBandwidth(bandwidth) {
        return this;
    }
    /** Returns whether the squelch level is settable. */
    hasSquelch() {
        return false;
    }
    /** Returns the current squelch level. */
    getSquelch() {
        return 0;
    }
    /** Sets the squelch level. */
    setSquelch(squelch) {
        return this;
    }
}
var registeredDemods = new Map();
function getRegisteredDemod(mode) {
    let scheme = typeof mode === "string" ? mode : mode.scheme;
    let reg = registeredDemods.get(scheme);
    if (!reg)
        throw `Scheme "${scheme}" was not registered.`;
    return reg;
}
