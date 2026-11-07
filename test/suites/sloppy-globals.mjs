// A classic script's top-level `var location = url` assigns the window's
// location (the var declares nothing new there), which navigates: through the
// proxy the navigation routes like `location = url`, so the frame lands on
// the real page instead of the proxy origin's path.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}pages/var-location.html`);
let title = '';
// a slow runner can take more than ten seconds to show the frame
for (let i = 0; i < 120 && title !== 'HIST 2'; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	title = await frame?.evaluate(() => document.title).catch(() => '');
}
ok(
	'a top-level var location navigates to the routed page',
	title === 'HIST 2',
	title,
);
await done(browser, page.errors);
