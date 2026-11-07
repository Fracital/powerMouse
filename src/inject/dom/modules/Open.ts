import Module from '../../Module';
import DocumentClient, { addDocumentOpenListener } from '../Client';

const SAME_FRAME = ['', '_self', '_top', '_parent', '_unfencedtop'];

/**
 * Links that would open a new browsing context (`target="_blank"`, a name
 * no frame of the page has, a modifier or middle click) are handed to the host application
 * when it opted in (`config.openTab`); the browser never opens the bare
 * proxied popup. Window hooks go through addDocumentOpenListener because
 * `document.open()` drops them.
 */
export default class OpenModule extends Module<DocumentClient> {
	apply() {
		if (!this.client.config.openTab) return;
		const global = this.client.global;

		const listener = (event: MouseEvent) => {
			if (event.defaultPrevented) return;
			if (event.type === 'auxclick' && event.button !== 1) return;
			if (event.type === 'click' && event.button !== 0) return;
			const link = event
				.composedPath()
				.find(
					(node): node is HTMLAnchorElement | HTMLAreaElement =>
						node instanceof global.Element &&
						(node.nodeName === 'A' || node.nodeName === 'AREA') &&
						node.hasAttribute('href'),
				);
			if (!link) return;
			// the hooked getters answer with what the page wrote
			const target = (
				link.getAttribute('target') ||
				global.document.querySelector('base[target]')?.getAttribute('target') ||
				''
			).toLowerCase();
			const modifier =
				event.type === 'auxclick' ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey;
			if (!modifier && SAME_FRAME.includes(target)) return;
			// a frame of this page by that name: the browser navigates it
			if (!modifier && this.client.hasFrameNamed(link.getAttribute('target')!))
				return;
			const url = new URL(
				link.getAttribute('href')!,
				this.client.url.toString(),
			);
			if (!['http:', 'https:'].includes(url.protocol)) return;
			if (this.client.openInHost(url.toString())) event.preventDefault();
		};
		const install = () => {
			global.addEventListener('click', listener, true);
			global.addEventListener('auxclick', listener, true);
		};
		install();
		addDocumentOpenListener(global, install);
	}
}
