import {
	IDENTITY_CLOSED,
	IDENTITY_GONE,
	type IdentityChooserRequest,
} from '../transport/messages';

/**
 * A proxied page's FedCM account chooser, drawn in the host's page over
 * the frame that shows the page (src/inject/dom/credentialFlows.ts asks
 * for it through the service worker). Natively the chooser is the
 * browser's own UI, outside the page: a page cannot see it being shown,
 * and so cannot learn that the user has accounts at the provider. Drawn in
 * the page itself it could, whatever hid its contents (a MutationObserver
 * sees the node added, elementFromPoint and layout see the box). Here the
 * page's document is never touched: the chooser sits in a closed shadow
 * root of the host's document, where the frame's hit testing, layout and
 * focus are not, and like Chrome's bubble it takes no focus when it shows.
 * What the page can still tell is what it can tell of Chrome's: its
 * request waits, and a press in the chooser takes the focus out of it.
 *
 * Resolves with the index of the account picked, IDENTITY_CLOSED when the
 * user closed it (Chrome's close button, which starts the site's cooldown)
 * or IDENTITY_GONE when `port` closed first (the document went away).
 */
export function drawAccountChooser(
	frame: HTMLIFrameElement | null,
	request: IdentityChooserRequest,
	port: MessagePort,
): Promise<number> {
	return new Promise((resolve) => {
		const host = document.createElement('div');
		const root = host.attachShadow({ mode: 'closed' });
		let open = true;
		const settle = (answer: number) => {
			if (!open) return;
			open = false;
			host.remove();
			removeEventListener('resize', place);
			try {
				port.close();
			} catch (error) {
				// already closed
			}
			resolve(answer);
		};
		port.addEventListener('close', () => settle(IDENTITY_GONE));
		port.start();

		const make = <K extends keyof HTMLElementTagNameMap>(
			tag: K,
			className: string,
			text?: string,
		) => {
			const element = document.createElement(tag);
			element.className = className;
			if (text !== undefined) element.textContent = text;
			return element;
		};
		const style = document.createElement('style');
		style.textContent =
			':host{all:initial}' +
			'.c{position:fixed;z-index:2147483647;width:360px;max-width:calc(100vw - 16px);box-sizing:border-box;background:#fff;color:#1f1f1f;border-radius:12px;box-shadow:0 2px 6px rgba(0,0,0,.15),0 8px 24px rgba(0,0,0,.2);font:14px system-ui,sans-serif;overflow:hidden}' +
			'.h{display:flex;align-items:center;gap:8px;padding:16px 12px 12px 20px;font-weight:500}' +
			'.t{flex:1}' +
			'.x{border:0;background:none;color:#444;cursor:pointer;font:20px/1 system-ui,sans-serif;width:32px;height:32px;border-radius:50%}' +
			'.x:hover,.a:hover{background:#f1f3f4}' +
			'.a{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 20px;width:100%;border:0;background:none;text-align:left;cursor:pointer;font:inherit;color:inherit}' +
			'.n{font-weight:500}' +
			'.e{color:#5f6368;font-size:13px}' +
			'.d{padding:12px 20px 16px;color:#5f6368;font-size:12px;border-top:1px solid #e0e0e0}' +
			'.d a{color:#0b57d0}';
		root.append(style);
		const card = make('div', 'c');
		card.setAttribute('role', 'dialog');
		const title = `Sign in to ${request.site} with ${request.idp}`;
		card.setAttribute('aria-label', title);
		const head = make('div', 'h');
		head.append(make('div', 't', title));
		const close = make('button', 'x', '×');
		close.type = 'button';
		close.setAttribute('aria-label', 'Close');
		close.addEventListener('click', () => settle(IDENTITY_CLOSED));
		head.append(close);
		card.append(head);
		request.accounts.forEach((account, index) => {
			const shown = account.name || account.email;
			const button = make('button', 'a');
			button.type = 'button';
			button.setAttribute(
				'aria-label',
				account.email && account.email !== shown
					? `${shown}, ${account.email}`
					: shown,
			);
			button.dataset.state = account.signUp ? 'sign-up' : 'sign-in';
			button.append(make('span', 'n', shown));
			if (account.email && account.email !== shown)
				button.append(make('span', 'e', account.email));
			button.addEventListener('click', () => settle(index));
			card.append(button);
		});
		// what a new account shares, as Chrome says it (with the site's links
		// the provider's client metadata named)
		const fresh = request.accounts.find((account) => account.signUp);
		if (fresh) {
			const note = make(
				'div',
				'd',
				`To continue, ${request.idp} will share your name, email address, and profile picture with this site.`,
			);
			const links: [string, string | undefined][] = [
				["this site's privacy policy", fresh.privacyPolicy],
				['terms of service', fresh.termsOfService],
			];
			const shown = links.filter(([, url]) => url);
			if (shown.length) {
				note.append(' See ');
				shown.forEach(([label, url], i) => {
					if (i) note.append(' and ');
					const link = make('a', '', label);
					link.href = url!;
					link.target = '_blank';
					link.rel = 'noopener noreferrer';
					note.append(link);
				});
				note.append('.');
			}
			card.append(note);
		}
		root.append(card);
		root.addEventListener('keydown', (event) => {
			if ((event as KeyboardEvent).key === 'Escape') settle(IDENTITY_CLOSED);
		});
		// at the top right of the frame, as Chrome's bubble sits at the top
		// right of the page under the toolbar
		const place = () => {
			const rect = frame?.isConnected ? frame.getBoundingClientRect() : null;
			const right = rect ? Math.max(0, innerWidth - rect.right) : 0;
			const top = rect ? Math.max(0, rect.top) : 0;
			card.style.top = `${top + 8}px`;
			card.style.right = `${right + 8}px`;
		};
		place();
		addEventListener('resize', place);
		document.body.append(host);
	});
}
