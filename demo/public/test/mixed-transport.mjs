// Test-only transport (the mixed-content suite; the demo uses it in place
// of epoxy when the server runs with STOMP_TEST_TRANSPORT=1). It is epoxy,
// except for the suite's fixture hosts (test/mixed-servers.mjs), which
// resolve nowhere: mixed.test and *.mixed.test go to 127.0.0.1, and an
// https or wss URL of mixed.test itself goes in plain http or ws, because
// epoxy takes no self-signed certificate and that server speaks both. The
// page's URL is still https, which is all mixed content is decided by.
// Anything under plain.mixed.test keeps its scheme, so an https load there
// fails as it does natively (that server has no TLS).
import EpoxyTransport from '../epoxy/index.mjs';

const FIXTURE_HOST = /^(?:[\w-]+\.)*mixed\.test$/;

function fixtureURL(url) {
	const target = new URL(url);
	if (!FIXTURE_HOST.test(target.hostname)) return target;
	if (target.hostname === 'mixed.test')
		target.protocol =
			{ 'https:': 'http:', 'wss:': 'ws:' }[target.protocol] ?? target.protocol;
	target.hostname = '127.0.0.1';
	return target;
}

export default class MixedTestTransport extends EpoxyTransport {
	request(remote, ...rest) {
		return super.request(fixtureURL(remote), ...rest);
	}
	connect(url, ...rest) {
		return super.connect(fixtureURL(url), ...rest);
	}
}
