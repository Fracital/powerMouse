// web-platform-tests navigation-api (test/wpt/navigation-api): the
// Navigation API natively and through the proxy in its default mode, where
// a proxied document is a frame navigated to its route and its navigation
// object is the browser's, with the History module's routing of the URLs
// it is given. wpt-navigation-api-dial runs the same pages in the dialing
// mode.
import { runWpt } from '../wpt.mjs';
import { NAVIGATION_API_SKIP } from '../wpt/lists/navigation-api.mjs';

await runWpt('wpt-navigation-api', {
	roots: ['navigation-api'],
	concurrency: 2,
	skip: NAVIGATION_API_SKIP,
});
