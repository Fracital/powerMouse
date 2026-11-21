// the ext-slot-content-scripts suite's pages: what the extension's scripts
// left on the document, as the page's own code reads it. A frame tells its
// top (its slot may be another's), the top keeps every document's in
// `window.slotDocs`
const which = new URLSearchParams(location.search).get('w') || 'top';
window.slotDocs = window.slotDocs || {};
const read = () => {
	const data = { ...document.documentElement.dataset };
	data.pageSaw = JSON.stringify({
		main: typeof window.mainGlobal,
		isolated: typeof window.csGlobal,
	});
	return data;
};
if (which === 'top')
	window.addEventListener('message', (event) => {
		if (event.data && event.data.slotDoc)
			window.slotDocs[event.data.slotDoc] = event.data.data;
	});
const tell = () => {
	if (which === 'top') window.slotDocs.top = read();
	else parent.postMessage({ slotDoc: which, data: read() }, '*');
};
// (again for a while: the scripts' messages answer after the load)
let told = 0;
const again = () => {
	tell();
	if (++told < 40) setTimeout(again, 250);
};
window.addEventListener('load', again);
