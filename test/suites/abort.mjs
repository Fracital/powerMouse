// A fetch the page aborts is dropped by the worker too: the page's rejection
// is the browser's (AbortError, at once), and the worker reports the request
// as aborted (status 0, error "aborted") when the abort arrives instead of
// after the origin's answer, which it stops waiting for; the body stream, if
// any had started, is cancelled. Same-origin mode, a controller of our own
// for the report.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const result = await page.evaluate(async (fixture) => {
	const log = [];
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: window.controller.transport,
		directory: window.controller.directory.pathname,
		codec: 'xor',
		onRequest: (info) => log.push(info),
	});
	await controller.wait();
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = controller.createFrame(element);
	const started = Date.now();
	await frame.go(`${fixture}pages/abort.html`);
	for (let i = 0; i < 40; i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (element.contentWindow?.__abort?.done) break;
	}
	// the report should be in well before the origin would have answered (5 s)
	await new Promise((resolve) => setTimeout(resolve, 700));
	const slow = log.find((info) => info.url.endsWith('/slow'));
	return {
		page: element.contentWindow?.__abort ?? null,
		report: slow
			? { status: slow.status, error: slow.error, kind: slow.kind }
			: null,
		reportedAfterMs: Date.now() - started,
	};
}, FIXTURE);
ok(
	'the page gets AbortError at once',
	result.page?.result === 'AbortError' && result.page?.ms < 1500,
	JSON.stringify(result.page),
);
ok(
	'the worker reports the request as aborted when the abort arrives',
	result.report?.status === 0 &&
		result.report?.error === 'aborted' &&
		result.reportedAfterMs < 4000,
	JSON.stringify([result.report, result.reportedAfterMs]),
);
await done(browser);
