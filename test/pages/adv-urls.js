// External classic script for adv-urls.html: what a script file learns about
// its own URL and the URLs in its stack traces.
__advRecord(
	'document.currentScript.src',
	document.currentScript ? document.currentScript.src : 'null',
);
__advRecord('external script Error().stack', new Error('adv').stack);
__advRecord(
	'external script caught stack',
	(() => {
		try {
			null.x;
		} catch (error) {
			return error.stack;
		}
	})(),
);
window.__advThrowLater = () => {
	setTimeout(() => {
		throw new Error('adv-uncaught');
	}, 0);
};
