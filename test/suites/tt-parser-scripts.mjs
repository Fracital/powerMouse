// A page whose Trusted Types are enforced (Google's sign-in page sends
// `require-trusted-types-for 'script'`) has inline scripts of its own:
// the parser's, which no sink set, so the browser runs them and reports
// nothing. Proxied, the inject copied the document's markup and judged
// each such script as text set through a sink: every one was reported as
// a trusted-types-sink violation of the page's own (22 on the sign-in
// page), each a trusted securitypolicyviolation event. The events fire as
// the document is made, so a listener that is there before the page's
// scripts (an init script here, as an extension's content script would
// be) is what hears them. Refused, an inline module ran nothing.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/tt-parser-scripts.html`;
const RAN = ['head', 'body', 'nested', 'module'];

/** every violation each document hears, from before its first script */
const listen = () => {
	window.__violations = [];
	EventTarget.prototype.addEventListener.call(
		document,
		'securitypolicyviolation',
		(event) =>
			window.__violations.push(
				`${event.effectiveDirective} ${event.blockedURI} ${event.sample.slice(0, 40)}`,
			),
		true,
	);
};
const report = () => ({
	ran: window.__ran ?? null,
	violations: window.__violations ?? null,
});

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.addInitScript(listen);
await nativePage.goto(PAGE);
for (let i = 0; i < 40; i++) {
	await sleep(250);
	if ((await nativePage.evaluate(report)).ran?.length === RAN.length) break;
}
// (a moment for any report to arrive)
await sleep(1000);
const native = await nativePage.evaluate(report);
ok(
	'natively every inline script runs and nothing is reported',
	JSON.stringify(native.ran) === JSON.stringify(RAN) &&
		native.violations.length === 0,
	JSON.stringify(native),
);

const page = await openDemo(browser, PROXY);
await page.addInitScript(listen);
await submitLanding(page, PAGE);
const read = async () => {
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	return (await frame?.evaluate(report).catch(() => null)) ?? null;
};
for (let i = 0; i < 80; i++) {
	await sleep(250);
	if ((await read())?.ran?.length === RAN.length) break;
}
await sleep(1000);
const proxied = await read();
ok(
	'proxied every inline script runs, in order',
	JSON.stringify(proxied?.ran) === JSON.stringify(native.ran),
	`${JSON.stringify(proxied?.ran)} vs ${JSON.stringify(native.ran)}`,
);
ok(
	"the page's own inline scripts are no Trusted Types violations",
	JSON.stringify(proxied?.violations) === JSON.stringify(native.violations),
	`${JSON.stringify(proxied?.violations)} vs ${JSON.stringify(native.violations)}`,
);
await done(browser, page.errors);
