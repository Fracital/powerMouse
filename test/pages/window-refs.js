// What a reference to another window gives the page that holds it: the
// suite compares the verdict of every path with the same page loaded
// natively. "restricted" is the browser's cross-origin WindowProxy (every
// read, call and write throws SecurityError); "RAW <title> {...}" names the
// document the reference reached and what worked on it.
window.refsInspect = function (get) {
	let w;
	try {
		w = get();
	} catch (error) {
		return `threw ${error.name}`;
	}
	if (w === null || w === undefined) return String(w);
	if (w === window) return 'self';
	const tries = {
		doc: () => w.document.title,
		href: () => w.location.href,
		storage: () => w.localStorage.getItem('refs'),
		cookie: () => w.document.cookie,
		call: () => w.refsSecret(),
		write: () => w.document.body.setAttribute('data-touched', '1'),
	};
	const out = {};
	for (const key of Object.keys(tries)) {
		try {
			tries[key]();
			out[key] = 'read';
		} catch (error) {
			out[key] = error.name;
		}
	}
	if (Object.values(out).every((value) => value === 'SecurityError'))
		return 'restricted';
	let title = '?';
	try {
		title = w.document.title;
	} catch (error) {
		// not readable
	}
	return `RAW ${title} ${JSON.stringify(out)}`;
};
// the same for a path that hands out a document
window.refsInspectDoc = function (get) {
	let d;
	try {
		d = get();
	} catch (error) {
		return `threw ${error.name}`;
	}
	if (d === null || d === undefined) return String(d);
	try {
		return `RAW document ${d.title}`;
	} catch (error) {
		return `document threw ${error.name}`;
	}
};
// the other host name of the fixture: another site
window.refsCross = function (path) {
	const url = new URL(path, location.href);
	url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
	return url.href;
};
