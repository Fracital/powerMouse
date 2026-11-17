// The WebRTC stand-in library (dist/rtcStack.js, the asset `rtcStack`): the
// inject's WebRTC module (modules/WebRTC.ts) evaluates this file the first
// time a document uses WebRTC and installs it for that document.
import { BUILD } from '../../version';
import type { RtcContext, StackApi } from './rtcLazy';
import WebRTCStack from './rtcStack';

// (handed out in an object the function the file is the body of is given:
// an export would have esbuild copy the module's names out with a for...of,
// which takes the page's Array.prototype[Symbol.iterator] by the time the
// file runs)
declare const __stompRtcOut: { api?: StackApi };
__stompRtcOut.api = {
	build: BUILD,
	install: (ctx: RtcContext) => new WebRTCStack().install(ctx),
};
