// XMLHttpRequest in a proxied page behaves like the browser's: responseType
// json, blob, arraybuffer and document give the parsed value, a Blob, an
// ArrayBuffer and a Document (responseXML too, and InvalidStateError under the
// other types), the event sequence is loadstart, progress, load, loadend, a
// timeout fires timeout and loadend with status 0, abort() fires abort and
// loadend, the upload target reports the body, withCredentials and timeout
// read back their defaults, and an async request to a real site completes.
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
await submitLanding(page, `${FIXTURE}pages/xhr.html`);
let xhr = {};
for (let i = 0; i < 120; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		xhr = (await frame.evaluate(() => window.__xhr)) || {};
	} catch (error) {
		xhr = {};
	}
	if (xhr.done) break;
}
const FULL = ['loadstart', 'progress', 'load', 'loadend'];
const events = (r) => JSON.stringify(r?.events);
ok(
	'responseType json, blob and arraybuffer give the browser types',
	xhr.jsonValue === 'object' &&
		xhr.json?.responseKind === 'object' &&
		xhr.blob?.responseKind === 'Blob' &&
		xhr.arraybuffer?.responseKind === 'ArrayBuffer' &&
		[xhr.json, xhr.blob, xhr.arraybuffer].every(
			(r) => r?.status === 200 && r?.error === 'InvalidStateError',
		),
	JSON.stringify([xhr.jsonValue, xhr.json, xhr.blob, xhr.arraybuffer]),
);
ok(
	'responseType document gives a Document and responseXML, text gives none for HTML',
	xhr.document?.responseKind === 'Document' &&
		xhr.document?.responseXML === 'HTML' &&
		xhr.htmlXML?.responseKind === 'string' &&
		xhr.htmlXML?.responseXML === null,
	JSON.stringify([xhr.document, xhr.htmlXML]),
);
ok(
	'the event sequence is loadstart, progress, load, loadend',
	[xhr.json, xhr.document, xhr.xml, xhr.misc].every(
		(r) => events(r) === JSON.stringify(FULL),
	),
	JSON.stringify([events(xhr.json), events(xhr.misc)]),
);
ok(
	'a timeout fires timeout and loadend with status 0',
	events(xhr.timeout) === JSON.stringify(['loadstart', 'timeout', 'loadend']) &&
		xhr.timeout?.status === 0 &&
		xhr.timeout?.readyState === 4,
	JSON.stringify(xhr.timeout),
);
ok(
	'abort() fires abort and loadend',
	events(xhr.abort) === JSON.stringify(['abort', 'loadend']) &&
		!xhr.abort?.hung,
	JSON.stringify(xhr.abort),
);
ok(
	'the upload target exists and reports the body',
	xhr.upload?.upload === 'object' &&
		xhr.upload?.uploadProgress === true &&
		xhr.upload?.uploadLoad === true &&
		xhr.upload?.status === 200,
	JSON.stringify(xhr.upload),
);
ok(
	'withCredentials and timeout read back their defaults and headers can be set',
	xhr.misc?.withCredentials === false &&
		xhr.misc?.timeoutDefault === 0 &&
		xhr.misc?.setHeader === 'ok' &&
		xhr.misc?.headerShape === true,
	JSON.stringify(xhr.misc),
);
ok(
	'an async request to a real site completes through the proxy',
	xhr.site?.status === 200 &&
		xhr.site?.responseURL === 'https://example.com/' &&
		xhr.site?.responseKind === 'string',
	JSON.stringify(xhr.site),
);
await done(browser, page.errors);
