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
 * A class to orchestrate the sample source, the demodulation process,
 * and the sample receiver, as a "radio" that can be started and stopped at will.
 */
import { RadioError, RadioErrorType } from "../errors.js";
import { SingleThread } from "./single_thread.js";
/** The type of 'radio' events. */
export class RadioEvent extends CustomEvent {
    constructor(e) {
        super("radio", { detail: e });
    }
}
/** Current state. */
var State;
(function (State) {
    State[State["OFF"] = 0] = "OFF";
    State[State["PLAYING"] = 1] = "PLAYING";
})(State || (State = {}));
/**
 * Provides controls to play, stop, and tune the radio.
 *
 * The command functions (start, stop, setParameter, etc) return promises that resolve when the
 * corresponding command has been processed. Commands are processed one at a time and in the same order
 * in which they were sent.
 *
 * There is a ready() function that returns a promise that resolves when all the commands sent
 * before the ready() function have been processed. It is useful when a subclass of Radio() sends commands
 * in the constructor, because then the ready() function will only resolve when all those commands
 * have been processed.
 */
export class Radio extends EventTarget {
    sourceProvider;
    sampleReceiver;
    options;
    /** @param sampleReceiver the object that will receive the radio samples. */
    constructor(sourceProvider, sampleReceiver, options) {
        super();
        this.sourceProvider = sourceProvider;
        this.sampleReceiver = sampleReceiver;
        this.options = options;
        this.sampleRate = 1024000;
        this.state = State.OFF;
        this.frequency = 88500000;
        this.parameterValues = new Map();
        this.singleThread = new SingleThread();
    }
    /** Current sample rate. */
    sampleRate;
    /** Current state. */
    state;
    /** Currently tuned frequency. */
    frequency;
    /** Current values of the properties. */
    parameterValues;
    /** Single thread to execute async functions. */
    singleThread;
    /** Handler for in-flight data transfers. */
    transfers;
    /** Current signal source. */
    source;
    /**
     * Starts playing the radio.
     *
     * @returns a promise that resolves after the command has been processed by the radio.
     */
    async start() {
        return this.singleThread.run(async () => {
            if (this.state != State.OFF)
                return;
            try {
                this.source = await this.sourceProvider.get();
                for (let [name, value] of this.parameterValues.entries()) {
                    await this.source.setParameter(name, value);
                }
                this.sampleRate = await this.source.setSampleRate(this.sampleRate);
                this.frequency = await this.source.setCenterFrequency(this.frequency);
                await this.source.startReceiving();
                this.transfers = new Transfers(this.source, this.sampleReceiver, this, this.sampleRate, this.options);
                await this.transfers.startStream();
                this.state = State.PLAYING;
                this.dispatchEvent(new RadioEvent({ type: "started" }));
            }
            catch (e) {
                this.dispatchEvent(new RadioEvent({ type: "error", exception: e }));
            }
        });
    }
    /**
     * Stops playing the radio.
     *
     * @returns a promise that resolves after the command has been processed by the radio.
     */
    async stop() {
        return this.singleThread.run(async () => {
            if (this.state != State.PLAYING)
                return;
            try {
                await this.transfers.stopStream();
                await this.source.close();
            }
            catch (e) {
                this.dispatchEvent(new RadioEvent({ type: "error", exception: e }));
            }
            this.state = State.OFF;
            this.dispatchEvent(new RadioEvent({ type: "stopped" }));
        });
    }
    /** Returns whether the radio is playing (or scanning). */
    isPlaying() {
        return this.state != State.OFF;
    }
    /**
     * Tunes the radio to this frequency.
     *
     * @returns a promise that resolves after the command has been processed by the radio.
     */
    async setFrequency(freq) {
        return this.singleThread.run(async () => {
            if (this.state == State.OFF) {
                this.frequency = freq;
            }
            else if (this.frequency != freq) {
                try {
                    this.frequency = await this.source.setCenterFrequency(freq);
                }
                catch (e) {
                    this.dispatchEvent(new RadioEvent({ type: "error", exception: e }));
                }
            }
        });
    }
    /** Returns the tuned frequency. */
    getFrequency() {
        return this.frequency;
    }
    /**
     * Changes the sample rate. This change only takes effect when the radio is started.
     *
     * @returns a promise that resolves after the command has been processed by the radio.
     */
    async setSampleRate(sampleRate) {
        return this.singleThread.run(async () => {
            if (this.sampleRate === sampleRate)
                return;
            if (this.state == State.OFF) {
                this.sampleRate = sampleRate;
                return;
            }
            try {
                await this.transfers.stopStream();
                this.sampleRate = await this.source.setSampleRate(sampleRate);
                this.transfers = new Transfers(this.source, this.sampleReceiver, this, this.sampleRate, this.options);
                await this.transfers.startStream();
            }
            catch (e) {
                this.dispatchEvent(new RadioEvent({ type: "error", exception: e }));
            }
        });
    }
    /** Returns the current sample rate. */
    getSampleRate() {
        return this.sampleRate;
    }
    /**
     * Sets the value of a parameter.
     *
     * @returns a promise that resolves after the command has been processed by the radio.
     */
    async setParameter(parameter, value) {
        return this.singleThread.run(async () => {
            if (this.state == State.OFF) {
                this.parameterValues.set(parameter, value);
                return;
            }
            try {
                this.parameterValues.set(parameter, await this.source.setParameter(parameter, value));
            }
            catch (e) {
                this.dispatchEvent(new RadioEvent({ type: "error", exception: e }));
            }
        });
    }
    /** Returns the value of a parameter. */
    getParameter(parameter) {
        return this.parameterValues.get(parameter);
    }
    /** Changes the radio's options. */
    async setOptions(options) {
        return this.singleThread.run(async () => {
            this.options = options;
            if (this.state == State.OFF)
                return;
            try {
                await this.transfers.stopStream();
                this.transfers = new Transfers(this.source, this.sampleReceiver, this, this.sampleRate, this.options);
                await this.transfers.startStream();
            }
            catch (e) {
                this.dispatchEvent(new RadioEvent({ type: "error", exception: e }));
            }
        });
    }
    /** Returns the radio's options. */
    getOptions() {
        return this.options || {};
    }
    /** Override this function to do something when a sample block is received. */
    onReceiveSamples(block) { }
    addEventListener(type, callback, options) {
        super.addEventListener(type, callback, options);
    }
}
/**
 * Transfer controller.
 *
 * Maintains 2 active transfers. When a transfer ends, it calls
 * the sample receiver's 'receiveSamples' function and starts a new
 * transfer. In this way, there is always a stream of samples coming in.
 */
class Transfers {
    source;
    sampleReceiver;
    radio;
    sampleRate;
    /** Receive this many buffers per second by default. */
    static DEFAULT_BUFS_PER_SEC = 20;
    constructor(source, sampleReceiver, radio, sampleRate, options) {
        this.source = source;
        this.sampleReceiver = sampleReceiver;
        this.radio = radio;
        this.sampleRate = sampleRate;
        let buffersPerSecond = options?.buffersPerSecond;
        if (buffersPerSecond === undefined || buffersPerSecond <= 0)
            buffersPerSecond = Transfers.DEFAULT_BUFS_PER_SEC;
        this.samplesPerBuf = 512 * Math.ceil(sampleRate / buffersPerSecond / 512);
        this.buffersWanted = 0;
        this.buffersRunning = 0;
        this.stopCallback = Transfers.nilCallback;
    }
    samplesPerBuf;
    buffersWanted;
    buffersRunning;
    stopCallback;
    static PARALLEL_BUFFERS = 2;
    /** Starts the transfers as a stream. */
    async startStream() {
        this.sampleReceiver.setSampleRate(this.sampleRate);
        this.buffersWanted = Transfers.PARALLEL_BUFFERS;
        while (this.buffersRunning < this.buffersWanted) {
            ++this.buffersRunning;
            this.readStream();
        }
    }
    /**
     * Stops the transfer stream.
     * @returns a promise that resolves when the stream is stopped.
     */
    async stopStream() {
        if (this.buffersRunning == 0 && this.buffersWanted == 0)
            return;
        let promise = new Promise((r) => {
            this.stopCallback = r;
        });
        this.buffersWanted = 0;
        return promise;
    }
    /** Runs the transfer stream. */
    async readStream() {
        try {
            while (this.buffersRunning <= this.buffersWanted) {
                const b = await this.source.readSamples(this.samplesPerBuf);
                this.radio.onReceiveSamples(b);
                this.sampleReceiver.receiveSamples(b);
            }
        }
        catch (e) {
            let error = new RadioError("Sample transfer was interrupted. Did you unplug your device?", RadioErrorType.TransferError, { cause: e });
            let event = new RadioEvent({ type: "error", exception: error });
            this.radio.dispatchEvent(event);
            this.stopCallback = () => this.radio.stop();
            this.buffersWanted = 0;
        }
        --this.buffersRunning;
        if (this.buffersRunning == 0) {
            this.stopCallback();
            this.stopCallback = Transfers.nilCallback;
        }
    }
    static nilCallback() { }
}
