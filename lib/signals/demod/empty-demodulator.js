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
import { getDemod, getMode, modeParameters } from "./modes.js";
import { AudioPlayer } from "../players/audioplayer.js";
/**
 * A class that takes a stream of radio samples and demodulates
 * it into an audio signal.
 *
 * The demodulator parameters (scheme, bandwidth, etc) are settable
 * on the fly.
 *
 * Whenever a parameter is changed, the demodulator emits a
 * 'demodulator' event containing the new value. This makes it easy
 * to observe the demodulator's state.
 */
export class Demodulator extends EventTarget {
    /**
     * @param options Options for the demodulator.
     */
    constructor(options) {
        super();
        this.inRate = 1024000;
        this.player = options?.player || new AudioPlayer();
        this.squelchControl = new SquelchControl(this.player.sampleRate);
        this.modeOptions = options?.modeOptions || {};
        this.mode = getMode("WBFM");
        this.demod = this.getScheme(this.mode);
        this.frequencyOffset = 0;
        this.latestStereo = false;
    }
    /** The sample rate. */
    inRate;
    /** The audio output device. */
    player;
    /** Controller that silences the output if the SNR is low. */
    squelchControl;
    /** Options for the different modes. */
    modeOptions;
    /** The modulation parameters as a Mode object. */
    mode;
    /** The demodulator class. */
    demod;
    /** The frequency offset to demodulate from. */
    frequencyOffset;
    /** Whether the latest samples were in stereo. */
    latestStereo;
    /** A frequency change we are expecting. */
    expectingFrequency;
    /** Changes the modulation parameters. */
    setMode(mode) {
        this.demod = this.getScheme(mode, this.demod);
        this.mode = mode;
    }
    /** Returns the current modulation parameters. */
    getMode() {
        return this.mode;
    }
    /** Changes the frequency offset. */
    setFrequencyOffset(offset) {
        this.frequencyOffset = offset;
    }
    /** Returns the current frequency offset. */
    getFrequencyOffset() {
        return this.frequencyOffset;
    }
    /** Waits until samples arrive with the given center frequency and then sets the offset. */
    expectFrequencyAndSetOffset(center, offset) {
        this.expectingFrequency = { center, offset };
    }
    /** Sets the audio volume level, from 0 to 1. */
    setVolume(volume) {
        this.player.setVolume(volume);
    }
    /** Returns the current audio volume level. */
    getVolume() {
        return this.player.getVolume();
    }
    /** Returns an appropriate instance of Scheme for the requested mode. */
    getScheme(mode, demod) {
        if (mode.scheme == demod?.getMode().scheme) {
            demod.setMode(mode);
            return demod;
        }
        return getDemod(this.inRate, this.player.sampleRate, mode, this.modeOptions[mode.scheme]);
    }
    /** Changes the sample rate. */
    setSampleRate(sampleRate) {
        this.inRate = sampleRate;
        this.demod = this.getScheme(this.mode, undefined);
    }
    /** Receives radio samples. */
    receiveSamples(block) {
        if (this.expectingFrequency?.center === block.frequency) {
            this.frequencyOffset = this.expectingFrequency.offset;
            this.expectingFrequency = undefined;
        }
        let { left, right, stereo, snr } = this.demod.demodulate(block.I, block.Q, this.frequencyOffset);
        this.squelchControl.applySquelch(this.mode, left, right, snr);
        this.player.play(left, right);
        if (stereo != this.latestStereo) {
            this.dispatchEvent(new StereoStatusEvent(stereo));
            this.latestStereo = stereo;
        }
    }
    addEventListener(type, callback, options) {
        super.addEventListener(type, callback, options);
    }
}
export class StereoStatusEvent extends CustomEvent {
    constructor(stereo) {
        super("stereo-status", { detail: stereo, bubbles: true, composed: true });
    }
}
class SquelchControl {
    sampleRate;
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
    }
    countdown = 0;
    applySquelch(mode, left, right, snr) {
        const SQUELCH_TAIL = 0.1;
        let params = modeParameters(mode);
        if (!params.hasSquelch())
            return;
        if (params.getSquelch() < snr) {
            this.countdown = SQUELCH_TAIL * this.sampleRate;
            return;
        }
        if (this.countdown > 0) {
            this.countdown -= left.length;
            return;
        }
        left.fill(0);
        right.fill(0);
    }
}
