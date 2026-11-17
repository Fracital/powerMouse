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
// - the visited suite's: v<port>.test and www.v<port>.test, sites on their
//   scheme's default port (Chrome's self-links need one), go to the fixture
//   on 127.0.0.1:<port>.
// - the demo-token suite's: discord.com and *.discord.com, a real host the
//   "Sign in with token" gate matches, with the fixture's port in the URL
//   (https://discord.com:<port>/...), go in plain http to the fixture on
//   127.0.0.1:<port>. No real credentials are used; it exercises the
//   write-and-navigate path with a dummy token.
// - the passkeys suite's relying party (test/passkeys-rp.mjs): pk<port>-a
//   and pk<port>-b under co.uk and github.io, and any name under them, sites
//   on https's default port (a relying party id names none), go in plain
//   http to that server on 127.0.0.1:<port>, with the name asked for in a
//   `pk-host` query parameter (epoxy's Host header is the address's). The
//   bare suffixes, trailing-dot names and addresses that the passkeys
//   suites ask about as relying party ids are refused here, so no test asks
//   the network (or a port of this machine) for them.
//
// It also gives epoxy the certificate authorities of the WebRTC suites' TURN
// server over TLS (test/turn.mjs, the certificate in turn-ca.pem here) and
// of the WebTransport suite's server (test/wtserver.mjs, webtransport-ca.pem).
import EpoxyTransport from '../epoxy/index.mjs';

const MIXED_HOST = /^(?:[\w-]+\.)*mixed\.test$/;
const PLAIN_MIXED_HOST = /^(?:[\w-]+\.h3\.)?mixed\.test$/;
const PRIVATE_SITE_HOST =
	/^(?:(?:[\w-]+\.)*stomp-a|stomp-b)\.(?:github\.io|blogspot\.com|s3\.eu-west-1\.amazonaws\.com|cloudfront\.net|co\.uk)$/;
const DISCORD_HOST = /^(?:[\w-]+\.)*discord\.com$/;
const PLAIN = { 'https:': 'http:', 'wss:': 'ws:' };
const PORT_HOST = /^(?:www\.)?v(\d+)\.test$/;
const PASSKEY_HOST = /^(?:[\w-]+\.)*pk(\d+)-[ab]\.(?:co\.uk|github\.io)$/;
// names the passkeys suites ask about that no server answers for (a public
// suffix as a relying party id, a name with a trailing dot): never the
// network's to answer in a test
const NOWHERE = /^(?:uk|co\.uk|com|io|github\.io)$|\.$/;
// and an address as a relying party id, whose /.well-known/webauthn would
// be https on the default port of that address
const ADDRESS = /^(?:\d+\.){3}\d+$|^\[/;
const nowhere = (url) =>
	NOWHERE.test(url.hostname) ||
	(url.protocol === 'https:' && url.port === '' && ADDRESS.test(url.hostname));

function fixtureURL(url) {
	const target = new URL(url);
	const { hostname } = target;
	const port = PORT_HOST.exec(hostname)?.[1];
	if (port && target.port === '') {
		target.hostname = '127.0.0.1';
		target.port = port;
		return target;
	}
	const passkeyPort = PASSKEY_HOST.exec(hostname)?.[1];
	if (passkeyPort && target.port === '') {
		target.protocol = PLAIN[target.protocol] ?? target.protocol;
		// that server answers by name (a related origins file is one
		// site's) and epoxy sends the Host of the address it connects to:
		// the name rides in the query
		target.search += `${target.search ? '&' : '?'}pk-host=${hostname}`;
		target.hostname = '127.0.0.1';
		target.port = passkeyPort;
		return target;
	}
	if (
		PRIVATE_SITE_HOST.test(hostname) ||
		PLAIN_MIXED_HOST.test(hostname) ||
		DISCORD_HOST.test(hostname)
	)
		target.protocol = PLAIN[target.protocol] ?? target.protocol;
	else if (!MIXED_HOST.test(hostname)) return target;
	target.hostname = '127.0.0.1';
	return target;
}

// The certificate authority of the WebRTC suites' TURN server over TLS
// (test/turn.mjs), which epoxy takes besides its own roots: the suites'
// turns: servers are reached as the real ones are, through epoxy's TLS
const TURN_CA = new URL('./turn-ca.pem', import.meta.url);
const WEBTRANSPORT_CA = new URL('./webtransport-ca.pem', import.meta.url);

export default class MixedTestTransport extends EpoxyTransport {
	async init() {
		this.opts.pem_files ??= await Promise.all(
			[TURN_CA, WEBTRANSPORT_CA].map(async (url) => (await fetch(url)).text()),
		);
		return super.init();
	}
	request(remote, ...rest) {
		if (nowhere(new URL(remote)))
			return Promise.reject(new Error('no such host in a test'));
		return super.request(fixtureURL(remote), ...rest);
	}
	connect(url, ...rest) {
		return super.connect(fixtureURL(url), ...rest);
	}
}
