// SPDX-License-Identifier: Apache-2.0
//
// Speech-to-text worker entry for the installed app (Isolated Web App). There
// the worker gets the app's own strict Content Security Policy from Chrome, so
// it is started from this file instead of a blob (which that policy forbids).

import "./guard.js";
import "./worker.js";
