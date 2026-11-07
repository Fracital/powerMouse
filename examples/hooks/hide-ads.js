// A post hook: the inject's hooks are in place and the page's first script
// has not run. Everything here is host code with the page's real globals;
// keep references in closures and never store `top` or `stomp.window` on
// anything the page can reach.
const selectors = ['.ad', '[id^="google_ads"]', 'iframe[src*="doubleclick"]'];
console.log(
	`stomp hook: ${stomp.phase} in ${stomp.url} (frame ${stomp.frameId})`,
);
if (stomp.kind === 'document')
	self.addEventListener('DOMContentLoaded', () => {
		const style = document.createElement('style');
		style.textContent = `${selectors.join(', ')} { display: none !important }`;
		document.head.append(style);
	});
