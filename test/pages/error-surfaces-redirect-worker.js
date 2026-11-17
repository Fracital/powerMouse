// A worker of the error-surfaces page that imports scripts of its own origin
// whose redirects go through another origin (to it, and back), with its
// resource timing buffer as the page left it, cleared, and full. Natively the
// browser mutes such a script: importScripts() throws a NetworkError whatever
// it threw. The page sends `{ cross }`, another origin's base.
const describe = (value) =>
	value === null || typeof value !== 'object'
		? String(value)
		: {
				ctor: value.constructor && value.constructor.name,
				name: value.name,
				message: value.message,
			};
const BUFFERS = {
	kept() {},
	cleared() {
		performance.clearResourceTimings();
	},
	full() {
		performance.setResourceTimingBufferSize(
			performance.getEntriesByType('resource').length,
		);
	},
};
self.onmessage = ({ data: { cross } }) => {
	const own = location.href.replace(/pages\/.*$/, '');
	const report = {};
	for (const [buffer, prepare] of Object.entries(BUFFERS)) {
		// (one load first, so a full buffer has an entry in it)
		fetch(`${own}pages/error-surfaces-throw.js?warm=${buffer}`);
		prepare();
		const thrower = `pages/error-surfaces-throw.js?worker=${buffer}`;
		const chains = {
			away: `${own}redirect?to=${encodeURIComponent(cross + thrower)}`,
			back: `${own}redirect?to=${encodeURIComponent(
				`${cross}redirect?to=${encodeURIComponent(`${own}${thrower}&back`)}`,
			)}`,
		};
		for (const [chain, url] of Object.entries(chains))
			try {
				importScripts(url);
				report[`${chain} ${buffer}`] = 'ran';
			} catch (error) {
				report[`${chain} ${buffer}`] = describe(error);
			}
	}
	postMessage(report);
};
