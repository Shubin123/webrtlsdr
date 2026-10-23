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
/** A SampleReceiver that counts received samples to send a `sample-click` event periodically. */
export class SampleCounter extends EventTarget {
    clicksPerSecond;
    /**
     * @param sampleRate The initial sample rate.
     * @param clicksPerSecond The number of events per second.
     */
    constructor(clicksPerSecond) {
        super();
        this.clicksPerSecond = clicksPerSecond;
        this.sampleRate = 1024000;
        this.samplesPerClick = this.getSamplesPerClick();
        this.countedSamples = 0;
    }
    sampleRate;
    samplesPerClick;
    countedSamples;
    getSamplesPerClick() {
        return this.clicksPerSecond === undefined
            ? undefined
            : Math.floor(this.sampleRate / this.clicksPerSecond);
    }
    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
        this.samplesPerClick = this.getSamplesPerClick();
    }
    receiveSamples(block) {
        this.countedSamples += block.I.length;
        if (this.samplesPerClick === undefined ||
            this.samplesPerClick > this.countedSamples)
            return;
        this.countedSamples %= this.samplesPerClick;
        this.dispatchEvent(new SampleClickEvent());
    }
    addEventListener(type, callback, options) {
        super.addEventListener(type, callback, options);
    }
}
export class SampleClickEvent extends Event {
    constructor() {
        super("sample-click");
    }
}
