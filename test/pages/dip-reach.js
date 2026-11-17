// The Document-Isolation-Policy reach battery (document-isolation suite),
// served by /coi/doc. `role=parent` frames a document of its own origin
// sent with every `fh` header and records, once it loads, what each of the
// two reaches of the other: its document, its location and the frame
// element's contentDocument.
(() => {
	const query = new URLSearchParams(location.search);
	if (query.get('role') !== 'parent') return;
	const read = (fn) => {
		try {
			return String(fn());
		} catch (error) {
			return `threw ${error.name}`;
		}
	};
	const src = new URL('/coi/doc', location.href);
	src.searchParams.set('script', '/pages/dip-reach.js');
	for (const header of query.getAll('fh')) src.searchParams.append('h', header);
	const frame = document.createElement('iframe');
	frame.src = src.href;
	frame.onload = () => {
		const child = frame.contentWindow;
		window.__dip = {
			row: query.get('row'),
			document: read(() => child.document.title),
			location: read(() => new URL(child.location.href).pathname),
			contentDocument: frame.contentDocument === null ? 'null' : 'a document',
			parent: read(() =>
				child.eval(
					'try { String(parent.document.title) } catch (error) { "threw " + error.name }',
				),
			),
		};
	};
	document.body.append(frame);
})();
