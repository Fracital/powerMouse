// a page's worker (offline-sites.html): what it is told, and a fetch of
// the page's suggestions from inside it
addEventListener('message', async (event) => {
	const response = await fetch(`offline-sites.json?from=worker`);
	const { words } = await response.json();
	postMessage([event.data, words.length, location.pathname]);
});
