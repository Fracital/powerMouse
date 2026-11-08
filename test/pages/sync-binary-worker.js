// the dedicated worker of sync-binary.html: synchronous XHRs, where a
// worker may set any response type, reported as strings to compare
const hex = (bytes) =>
	Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
const codes = (text) =>
	Array.from({ length: text.length }, (_, i) =>
		text.charCodeAt(i).toString(16).padStart(4, '0'),
	).join(' ');
const headers = (x) => ({
	status: x.status,
	statusText: x.statusText,
	responseURL: x.responseURL,
	type: x.getResponseHeader('content-type'),
	length: x.getResponseHeader('content-length'),
	marker: x.getResponseHeader('x-sync-binary'),
});
const sync = (url, type, override) => {
	const x = new XMLHttpRequest();
	x.open('GET', url, false);
	if (type) x.responseType = type;
	if (override) x.overrideMimeType(override);
	x.send();
	return x;
};
const out = {};
const attempt = (name, run) => {
	try {
		out[name] = run();
	} catch (error) {
		out[name] = { threw: error.name, message: String(error.message) };
	}
};
attempt('arraybuffer', () => {
	const x = sync('/pages/sync-binary.bin', 'arraybuffer');
	return { ...headers(x), bytes: hex(x.response) };
});
attempt('userDefined', () => {
	const x = sync(
		'/pages/sync-binary.bin',
		'',
		'text/plain; charset=x-user-defined',
	);
	return { ...headers(x), codes: codes(x.responseText) };
});
attempt('latin1', () => {
	const x = sync('/pages/sync-latin1.bin', 'text');
	return { ...headers(x), codes: codes(x.responseText) };
});
attempt('utf8', () => {
	const x = sync('/pages/sync-utf8.bin');
	return { ...headers(x), codes: codes(x.responseText) };
});
attempt('blob', () => {
	const x = sync('/pages/sync-binary.bin', 'blob');
	return { ...headers(x), type: x.response.type, size: x.response.size };
});
(async () => {
	if (out.blob && !out.blob.threw) {
		const x = sync('/pages/sync-binary.bin', 'blob');
		out.blob.bytes = hex(await x.response.arrayBuffer());
	}
	postMessage(out);
})();
