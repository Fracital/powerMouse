/**
 * The schemes Chrome's omnibox navigates to as typed, with their own
 * handling, minus `javascript:` (it runs in the page the user is on, which
 * here is the host's, not the proxied page) and the browser's own pages
 * (`chrome:` and friends, which have no proxied counterpart). Anything else
 * that looks like `scheme:rest` is searched, as the omnibox does for a
 * scheme no handler is registered for.
 */
const PASSED = new Set([
	'http',
	'https',
	'ftp',
	'file',
	'about',
	'blob',
	'data',
	'filesystem',
	'view-source',
	'mailto',
	'tel',
	'sms',
]);

/**
 * Top-level names that are not public suffixes, so a host under them is not
 * unique and Chrome's omnibox does not upgrade it to https. (Chrome asks the
 * public suffix list; these are the common private ones.)
 */
const PRIVATE_TLDS = new Set([
	'localhost',
	'local',
	'test',
	'example',
	'invalid',
	'internal',
	'lan',
	'home',
	'corp',
	'intranet',
	'arpa',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** `host`: the host Chrome reaches over https when typed without a scheme */
function upgraded(host: string, port: boolean): boolean {
	if (port || host.startsWith('[') || IPV4.test(host)) return false;
	const labels = host.split('.');
	return (
		labels.length > 1 && !PRIVATE_TLDS.has(labels[labels.length - 1] ?? '')
	);
}

/**
 * Turns what a user typed into an address bar into a URL, as Chrome's
 * omnibox does:
 *
 * - a URL with a scheme the omnibox navigates to (`https:`, `ftp:`,
 *   `view-source:`, `data:`, `about:` ...; see PASSED) is kept, the scheme
 *   and host in lower case and spaces in the path encoded
 *   (`HTTPS://EXAMPLE.COM` is `https://example.com/`);
 * - a host with an optional port and path (`example.com/a b`,
 *   `localhost:8080`, `192.168.0.1`) gets a scheme: `https://` for a public
 *   host, the default of Chrome's omnibox since Chrome 90, and `http://`
 *   for one Chrome does not upgrade (an IP address, `localhost`, a single
 *   label, a private top-level name such as `.local` or `.test`, an address
 *   with a port). Chrome falls back to `http://` when the https load fails;
 *   a proxied frame shows the error page instead, and the user can type the
 *   `http://` address;
 * - anything else (words, a scheme nothing handles) is a search:
 *   `template` with `%s` replaced by the encoded text.
 */
export default class SearchBuilder {
	template: string;
	constructor(template: string) {
		this.template = template;
	}
	query(input: string): string {
		const text = input.trim();
		const search = () => this.template.replace('%s', encodeURIComponent(text));
		const scheme = /^([a-z][a-z\d+.-]*):(.*)$/is.exec(text);
		// `localhost:8080/x`, `example.com:443`: a host and its port
		if (scheme && !/^\d+(?:[/?#]|$)/.test(scheme[2] ?? '')) {
			if (!PASSED.has((scheme[1] ?? '').toLowerCase())) return search();
			try {
				return new URL(text).href;
			} catch (error) {
				return search();
			}
		}
		// a host (no space, no user name), then a path, query or fragment,
		// which may have spaces in it
		const authority = /^[^/?#]*/.exec(text)?.[0] ?? '';
		const host = /^([^\s@:]+|\[[\d:a-f.]+\])(:\d+)?$/i.exec(authority);
		if (!host) return search();
		const name = (host[1] ?? '').toLowerCase();
		const labels = name.split('.');
		const last = labels[labels.length - 1] ?? '';
		const hostLike =
			name === 'localhost' ||
			name.endsWith('.localhost') ||
			name.startsWith('[') ||
			IPV4.test(name) ||
			// a dotted name whose last label is not a number (`1.5` is searched)
			(labels.length > 1 && labels.every(Boolean) && !/^\d+$/.test(last)) ||
			// a single label with a port (`intranet:8080`)
			!!host[2];
		if (!hostLike) return search();
		try {
			return new URL(
				`${upgraded(name, !!host[2]) ? 'https' : 'http'}://${text}`,
			).href;
		} catch (error) {
			return search();
		}
	}
}
