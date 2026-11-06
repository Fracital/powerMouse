// The cookie jar: a Max-Age cookie lives for its whole Max-Age (not a
// thousandth of it), Max-Age=0 deletes, and a session cookie survives both.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

/** navigate the tab to a fixture cookie page and read what it saw */
async function visit(path, first = false) {
	if (first) await submitLanding(page, `${FIXTURE}pages/cookie-${path}.html`);
	else await submitOmni(page, `${FIXTURE}pages/cookie-${path}.html`);
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		const frame = page.frames().find((f) => f.url().includes('/stomp/html/'));
		try {
			const text = await frame.evaluate(() =>
				document.title === 'COOKIES'
					? document.getElementById('c').textContent
					: null,
			);
			if (text !== null) return text;
		} catch (error) {
			// navigating
		}
	}
	throw new Error(`cookie page ${path} did not render`);
}

const afterSet = await visit('set', true);
ok('Max-Age cookie set', /\bma=1\b/.test(afterSet), afterSet);
ok('session cookie set', /\bsess=1\b/.test(afterSet), afterSet);

// 3600 s taken as 3600 ms would have expired it by now
await sleep(5000);
const later = await visit('show');
ok(
	'Max-Age cookie still there after five seconds',
	/\bma=1\b/.test(later),
	later,
);

const afterDel = await visit('del');
ok('Max-Age=0 deletes the cookie', !/\bma=/.test(afterDel), afterDel);
ok(
	'session cookie survives the deletion',
	/\bsess=1\b/.test(afterDel),
	afterDel,
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
