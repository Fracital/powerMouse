// The cookie jar: a Max-Age cookie lives for its whole Max-Age (not a
// thousandth of it), Max-Age=0 deletes, and a session cookie survives both.
// A 429 navigation's cookies are kept and sent with the next one.
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
		const frame = page
			.frames()
			.find((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
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

// A navigation answered 429 renders its page and keeps its Set-Cookie, as
// Chrome does: Wikimedia's rate limit can answer a first visit with 429 and
// its cookies, and the next visit, which sends them, gets the article.
const after429 = await visit('429');
ok(
	'a 429 page renders and its cookie is set',
	/\brl=1\b/.test(after429),
	after429,
);
ok(
	'its HttpOnly cookie stays out of document.cookie',
	!/\brlh=/.test(after429),
	after429,
);
await submitOmni(page, `${FIXTURE}echo-headers?k=cookie-429`);
let sent429 = null;
for (let i = 0; i < 40 && !sent429; i++) {
	await sleep(250);
	sent429 = await (
		await fetch(`${FIXTURE}echo-headers/recorded?k=cookie-429`)
	).json();
}
ok(
	'the next navigation sends both cookies of the 429',
	/\brl=1\b/.test(sent429?.cookie ?? '') &&
		/\brlh=1\b/.test(sent429?.cookie ?? ''),
	JSON.stringify(sent429?.cookie ?? null),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
