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
	const frame = page.frames().find((f) => f.url().includes('/stomp/html/'));
	try {
		apis = (await frame.evaluate(() => window.__apis)) || {};
	} catch (error) {
		apis = {};
	}
	if (apis.idbName !== undefined && apis.fetchRequest !== undefined) break;
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

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
