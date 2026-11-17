// The Cross-Origin-Opener-Policy battery (coop suite), served by
// /coi/doc with the policy the query names. `role=opener` opens `u` in a
// popup named `coop-<row>` (with `frame=1`, a same-origin child frame
// opens it, sent with `child=<policy>`, of `childOrigin` when there is
// one), then reads what it still has of
// the popup: whether it is closed, its frames, its location and whether a
// message reaches it, at once and after the popup went on to its `next`
// page. `role=popup` records whether it has an opener, its name and the
// messages it got.
(() => {
	const query = new URLSearchParams(location.search);
	const role = query.get('role');
	const row = query.get('row');
	const read = (fn) => {
		try {
			return fn();
		} catch (error) {
			return `threw ${error.name}`;
		}
	};
	if (role === 'popup') {
		const state = (window.__coopPopup = {
			row,
			page: query.get('next') ? 'first' : 'last',
			opener: read(() => (window.opener === null ? 'null' : 'window')),
			name: read(() => window.name),
			messages: [],
		});
		addEventListener('message', (event) => {
			if (event.data && event.data.coop) state.messages.push(event.data.coop);
		});
		const next = query.get('next');
		if (next) setTimeout(() => location.replace(next), 2500);
		return;
	}
	const look = (w) => ({
		closed: read(() => w.closed),
		length: read(() => w.length),
		href: read(() => w.location.href.replace(/\?.*$/, '?')),
		opener: read(() => (w.opener === window ? 'this' : String(w.opener))),
	});
	const run = () => {
		const w = window.open(query.get('u'), `coop-${row}`);
		const result = { row, opened: w !== null };
		window.__coop = result;
		if (!w) {
			result.done = true;
			return;
		}
		setTimeout(() => {
			result.first = look(w);
			read(() => w.postMessage({ coop: 'first' }, '*'));
		}, 1800);
		setTimeout(() => {
			result.last = look(w);
			read(() => w.postMessage({ coop: 'last' }, '*'));
			setTimeout(() => (result.done = true), 600);
		}, 5500);
	};
	if (role === 'opener' && query.get('frame') === '1') {
		const frame = document.createElement('iframe');
		const child = new URL(
			'/coi/doc',
			query.get('childOrigin') || location.href,
		);
		child.searchParams.set('script', '/pages/coop.js');
		child.searchParams.set('role', 'child');
		child.searchParams.set('row', row);
		child.searchParams.set('u', query.get('u'));
		const policy = query.get('child');
		if (policy)
			child.searchParams.append('h', `cross-origin-opener-policy:${policy}`);
		frame.src = child.href;
		document.body.append(frame);
		return;
	}
	if (role === 'opener' || role === 'child') run(window);
})();
