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
import * as Wasm from "./wasm-bytes.js";
let fftModule = new WebAssembly.Module(Wasm.FFT);
function checkPtr(ptr) {
    if (ptr < 0)
        throw "could not reserve memory";
    return ptr;
}
export class WasmFft {
    wasm;
    constructor(wasm) {
        this.wasm = wasm;
    }
    setCoefs(coefs) {
        const ptr = checkPtr(this.wasm.coefsPtr(coefs.length));
        this.setArray(ptr, coefs.length, coefs);
    }
    setExpnCoefs(coefs) {
        const ptr = checkPtr(this.wasm.expnCoefsPtr());
        this.setArray(ptr, coefs.length, coefs);
    }
    fft(real, imag, reverse) {
        const len = this.wasm.getFftLength();
        let r = this.setArray(this.wasm.realDataPtr(), len, real);
        let i = this.setArray(this.wasm.imagDataPtr(), len, imag);
        this.wasm.fft(reverse);
        return [r, i];
    }
    realFftPost() {
        let len = this.wasm.getFftLength();
        this.wasm.expandRealFft();
        let r = this.getArray(this.wasm.expnRealDataPtr(), len * 2);
        let i = this.getArray(this.wasm.expnImagDataPtr(), len * 2);
        return [r, i];
    }
    reverseRealFftPre(real, imag) {
        let len = this.wasm.getFftLength();
        this.setArray(this.wasm.expnRealDataPtr(), 2 * len, real);
        this.setArray(this.wasm.expnImagDataPtr(), 2 * len, imag);
        this.wasm.collapseRealFft();
        let e = this.getArray(this.wasm.realDataPtr(), len);
        let o = this.getArray(this.wasm.imagDataPtr(), len);
        return [e, o];
    }
    getArray(ptr, size) {
        return new Float32Array(this.wasm.memory.buffer, ptr, size);
    }
    setArray(ptr, size, value) {
        let a = this.getArray(ptr, size);
        if (value.length > size) {
            a.set(value.subarray(0, size));
            return a;
        }
        if (value.length < size)
            a.fill(0, value.length);
        a.set(value);
        return a;
    }
}
export function getWasmFft() {
    return new WasmFft(new WebAssembly.Instance(fftModule).exports);
}
