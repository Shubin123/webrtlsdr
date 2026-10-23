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
/** A "composite" sample receiver that executes its component receivers in sequence. */
export class CompositeReceiver {
    receivers;
    /** Creates a CompositeReceiver out of the given SampleReceivers. */
    static of(first, ...rest) {
        let list = [];
        if (first instanceof CompositeReceiver) {
            list.push(...first.receivers);
        }
        else {
            list.push(first);
        }
        for (let next of rest) {
            if (next instanceof CompositeReceiver) {
                list.push(...next.receivers);
            }
            else {
                list.push(next);
            }
        }
        if (list.length == 1)
            return list[0];
        return new CompositeReceiver(list);
    }
    constructor(receivers) {
        this.receivers = receivers;
    }
    setSampleRate(sampleRate) {
        for (let receiver of this.receivers) {
            receiver.setSampleRate(sampleRate);
        }
    }
    receiveSamples(block) {
        for (let receiver of this.receivers) {
            receiver.receiveSamples(block);
        }
    }
}
