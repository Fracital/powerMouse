// web-platform-tests navigation-api (test/wpt/navigation-api) in the
// dialing mode (just call stomp, src/controller/justCallStomp.ts): each
// proxied page is a tab of its own, written into a constant call page, and
// its navigation object, events and session history are the inject's
// (src/inject/dom/calledNavigation.ts) over the history the host keeps.
// Compared with the same native run as wpt-navigation-api.
import { runWpt } from '../wpt.mjs';
import { NAVIGATION_API_SKIP } from '../wpt/lists/navigation-api.mjs';

await runWpt('wpt-navigation-api-dial', {
	roots: ['navigation-api'],
	concurrency: 2,
	called: true,
	skip: NAVIGATION_API_SKIP,
});
