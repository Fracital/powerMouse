// The WebRTC stand-in library (dist/rtcStack.js, the asset `rtcStack`): the
// inject's WebRTC module (modules/WebRTC.ts) evaluates this file the first
// time a document uses WebRTC and installs it for that document.
import { BUILD } from '../../version';
import type { RtcContext, StackApi } from './rtcLazy';
import WebRTCStack from './rtcStack';

export const api: StackApi = {
	build: BUILD,
	install: (ctx: RtcContext) => new WebRTCStack().install(ctx),
};
