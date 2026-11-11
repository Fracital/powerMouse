// Test-only transport (the demo uses it in place of epoxy when the server
// runs with STOMP_TEST_TRANSPORT=1, which test/run.mjs sets for the suites
// that need it). It is epoxy, except for the fixture hosts below, which
// resolve nowhere and go to 127.0.0.1:
//
// - the mixed-content suite's (test/mixed-servers.mjs): mixed.test and
//   *.mixed.test, and an https or wss URL of mixed.test itself goes in
//   plain http or ws, because epoxy takes no self-signed certificate and
//   that server speaks both. The page's URL is still https, which is all
//   mixed content is decided by. Anything under plain.mixed.test keeps its
//   scheme, so an https load there fails as it does natively (that server
//   has no TLS). The names under h3.mixed.test are more https origins that
//   go in plain http, for the suites that need several origins offering
//   HTTP/3 (demo-http3, http3-fallback).
// - the sites under a private suffix (test/private-sites.mjs): stomp-a and
//   stomp-b under github.io, blogspot.com, s3.eu-west-1.amazonaws.com,
//   cloudfront.net and co.uk, and any name under stomp-a; https and wss go
//   in plain http and ws for the same reason.
import EpoxyTransport from '../epoxy/index.mjs';

const MIXED_HOST = /^(?:[\w-]+\.)*mixed\.test$/;
const PLAIN_MIXED_HOST = /^(?:[\w-]+\.h3\.)?mixed\.test$/;
const PRIVATE_SITE_HOST =
	/^(?:(?:[\w-]+\.)*stomp-a|stomp-b)\.(?:github\.io|blogspot\.com|s3\.eu-west-1\.amazonaws\.com|cloudfront\.net|co\.uk)$/;
const PLAIN = { 'https:': 'http:', 'wss:': 'ws:' };

function fixtureURL(url) {
	const target = new URL(url);
	const { hostname } = target;
	if (PRIVATE_SITE_HOST.test(hostname) || PLAIN_MIXED_HOST.test(hostname))
		target.protocol = PLAIN[target.protocol] ?? target.protocol;
	else if (!MIXED_HOST.test(hostname)) return target;
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
