import { NAVIGATE, NavigateInfo } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';

/**
 * Tells the host application where the page is (URL, title, whether its
 * own history can step) whenever that changes: on load, pushState and
 * replaceState, popstate and hashchange, and title changes. The host keeps
 * its address bar and buttons current from these instead of polling.
 */
export default class NavigateModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		// the page's own history, before anything the page does to the API
		const navigation = (
			global as { navigation?: { canGoBack: boolean; canGoForward: boolean } }
		).navigation;

		// this document's service worker client id, from the service worker
		// itself (a page cannot read it); the host attributes requests with it
		let client: string | undefined;
		// about:srcdoc and blob: documents have no proxy-origin URL to ask
		if (/^https?:$/.test(global.location.protocol))
			fetch(`${global.location.origin}${this.client.directory}whoami`)
				.then((response) => response.json())
				.then((id) => {
					if (typeof id === 'string') {
						client = id;
						post();
					}
				})
				.catch(() => {});

		let last = '';
		const post = () => {
			const info: NavigateInfo = {
				url: this.client.url.toString(),
				title: global.document.title,
				canGoBack: navigation ? !!navigation.canGoBack : null,
				canGoForward: navigation ? !!navigation.canGoForward : null,
				...(client ? { client } : {}),
			};
			const key = JSON.stringify(info);
			if (key === last) return;
			last = key;
			this.client.postToHost({ [NAVIGATE]: info });
		};

		// many mutations land at once (a whole page), one message per turn
		let scheduled = false;
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			global.setTimeout(() => {
				scheduled = false;
				post();
			}, 0);
		};

		for (const name of ['pushState', 'replaceState'] as const)
			global.History.prototype[name] = proxyModule.wrapFunction(
				global.History.prototype[name],
				(target, that, args) => {
					const result = Reflect.apply(target, that, args);
					schedule();
					return result;
				},
			);

		// document.open() drops window listeners (and runs before the real
		// page is written), so both are registered again after each open
		const listen = () => {
			for (const event of [
				'load',
				'DOMContentLoaded',
				'popstate',
				'hashchange',
			])
				global.addEventListener(event, schedule);
		};
		listen();
		addDocumentOpenListener(global, listen);

		const observer = new global.MutationObserver(schedule);
		const observe = () =>
			observer.observe(global.document, {
				subtree: true,
				childList: true,
				characterData: true,
			});
		observe();
		addDocumentOpenListener(global, observe);
	}
}
