// test/firefox/smoke.mjs: what a dedicated worker of firefox-smoke.html
// reads of itself and fetches
(async () => {
	let fetched;
	try {
		fetched = (await (await fetch('/pages/um-data.json')).json()).value;
	} catch (error) {
		fetched = `threw ${error.name}`;
	}
	postMessage({ href: location.href, origin: self.origin, fetched });
})();
