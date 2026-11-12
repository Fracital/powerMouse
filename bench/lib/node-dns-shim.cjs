// Preloaded (`node --require`) into the contenders that fetch from Node
// themselves (stompV1's Bare server, powerMouseV1), so they reach the
// harness's fixture hosts under *.bench.test the way holyWisp does through
// the harness DNS. Every other name goes to the system resolver unchanged.
// a --require preload has to be CommonJS
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dns = require('node:dns');

const SUFFIX = '.bench.test';
const local = (hostname) =>
	typeof hostname === 'string' &&
	(hostname === 'bench.test' || hostname.toLowerCase().endsWith(SUFFIX));

const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}
	if (!local(hostname)) return lookup.call(this, hostname, options, callback);
	const all = typeof options === 'object' && options && options.all;
	process.nextTick(() =>
		all
			? callback(null, [{ address: '127.0.0.1', family: 4 }])
			: callback(null, '127.0.0.1', 4),
	);
	return {};
};
const promises = dns.promises.lookup;
dns.promises.lookup = function (hostname, options) {
	if (!local(hostname)) return promises.call(this, hostname, options);
	const all = typeof options === 'object' && options && options.all;
	return Promise.resolve(
		all
			? [{ address: '127.0.0.1', family: 4 }]
			: { address: '127.0.0.1', family: 4 },
	);
};
