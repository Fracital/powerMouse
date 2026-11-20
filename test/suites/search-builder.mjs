// SearchBuilder turns what a user typed into a URL as Chrome's omnibox
// does. It matched schemes case-sensitively (HTTPS://EXAMPLE.COM became
// http://HTTPS://EXAMPLE.COM), put http:// in front of every other scheme
// (ftp://x became http://ftp://x), gave a bare host http:// where the
// omnibox has defaulted to https:// since Chrome 90, and kept a space in a
// path as it was. No browser is needed: dist/SearchBuilder.js runs in a
// realm of its own here, as the classic script a host loads.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { done, ok } from '../lib.mjs';

const realm = createContext({ URL });
runInContext(
	readFileSync(new URL('../../dist/SearchBuilder.js', import.meta.url), 'utf8'),
	realm,
);
const search = new realm.SearchBuilder('https://search.test/?q=%s');
const searched = (text) =>
	`https://search.test/?q=${encodeURIComponent(text.trim())}`;

const cases = [
	// a scheme in any case is a scheme
	['HTTPS://EXAMPLE.COM', 'https://example.com/'],
	['Http://Example.com/Path', 'http://example.com/Path'],
	['https://example.com/a b', 'https://example.com/a%20b'],
	// other schemes the omnibox navigates to pass through, unprefixed
	['ftp://x', 'ftp://x/'],
	['FTP://files.example.com/pub', 'ftp://files.example.com/pub'],
	['view-source:https://example.com/', 'view-source:https://example.com/'],
	['about:blank', 'about:blank'],
	['data:text/html,hi', 'data:text/html,hi'],
	['mailto:someone@example.com', 'mailto:someone@example.com'],
	['file:///etc/hosts', 'file:///etc/hosts'],
	// a scheme nothing handles, and javascript:, are searched
	['foo:bar', searched('foo:bar')],
	['javascript:alert(1)', searched('javascript:alert(1)')],
	// a bare public host gets https://, as the omnibox gives it
	['example.com', 'https://example.com/'],
	['EXAMPLE.com/Path', 'https://example.com/Path'],
	[
		'en.wikipedia.org/wiki/Web_proxy',
		'https://en.wikipedia.org/wiki/Web_proxy',
	],
	['example.com/a b', 'https://example.com/a%20b'],
	['example.com?q=a b', 'https://example.com/?q=a%20b'],
	// and http:// where Chrome does not upgrade
	['localhost', 'http://localhost/'],
	['localhost:8080/x', 'http://localhost:8080/x'],
	['www.localhost/', 'http://www.localhost/'],
	['127.0.0.1:8084/pages/', 'http://127.0.0.1:8084/pages/'],
	['192.168.0.1', 'http://192.168.0.1/'],
	['[::1]:8080', 'http://[::1]:8080/'],
	['printer.local', 'http://printer.local/'],
	['site.test/a', 'http://site.test/a'],
	['example.com:8443', 'http://example.com:8443/'],
	['intranet:8080', 'http://intranet:8080/'],
	// words are searched
	['hello', searched('hello')],
	['what is 1.5', searched('what is 1.5')],
	['1.5', searched('1.5')],
	['a b.com', searched('a b.com')],
	['  padded words  ', searched('padded words')],
	['user@example.com', searched('user@example.com')],
];
for (const [input, want] of cases) {
	const got = search.query(input);
	ok(`${JSON.stringify(input)} is ${want}`, got === want, got);
}

await done(null);
