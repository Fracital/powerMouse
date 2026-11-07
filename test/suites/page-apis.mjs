// Small page APIs that real sites trip over: location.reload exists on the
// location proxy, IDBDatabase.name reports the name the page used, and
// fetch(Request) with a body works.
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
await submitLanding(page, `${FIXTURE}pages/apis.html`);

let apis = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.find((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		apis = (await frame.evaluate(() => window.__apis)) || {};
	} catch (error) {
		apis = {};
	}
	if (
		apis.idbName !== undefined &&
		apis.fetchRequest !== undefined &&
		apis.upload !== undefined
	)
		break;
}
ok(
	'location.reload is a function',
	apis.reload === true,
	JSON.stringify(apis.reload),
);
ok(
	'IDBDatabase.name is the name the page opened',
	apis.idbName === 'mydb',
	JSON.stringify(apis.idbName),
);
ok(
	'fetch(Request) with a body works',
	apis.fetchRequest?.ok === true,
	JSON.stringify(apis.fetchRequest),
);

ok(
	'a 3 MB streamed upload arrives whole',
	apis.upload === 3 * 1024 * 1024,
	JSON.stringify(apis.upload),
);

ok(
	'pushState refuses another origin with SecurityError and takes its own',
	apis.pushCross === 'SecurityError' && apis.pushSame === '?replaced',
	JSON.stringify([apis.pushCross, apis.pushSame]),
);

ok(
	'an asynchronous XHR completes with its real URL',
	JSON.stringify(apis.xhrAsync) ===
		JSON.stringify([200, `${FIXTURE}pages/fresh.json`, true]),
	JSON.stringify(apis.xhrAsync),
);

ok(
	'eval returns a non-string unchanged and the generator constructors run rewritten',
	JSON.stringify(apis.evalNonString) ===
		JSON.stringify([true, true, true, true]) &&
		JSON.stringify(apis.generator) ===
			JSON.stringify([true, true, true, 'function']),
	JSON.stringify([apis.evalNonString, apis.generator]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
