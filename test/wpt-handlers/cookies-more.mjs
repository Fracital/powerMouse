// The wptserve pieces the vendored cookies/ tests of the wpt-cookies-more
// suite need (test/wpt/lists/cookies-more.mjs): the SameSite handlers of
// cookies/resources/, on top of the ones test/wpt-server.mjs has.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

// the directories of the suite: their pages get the helper below
const DIRS = ['samesite', 'samesite-none-secure', 'domain'];
const HELPER = '/cookies/resources/cookie-helper.sub.js';
// cookie-helper.sub.js builds its secure origins as "https://" + a host; on
// the fixture those are http origins (localhost and 127.0.0.1 are secure
// contexts). The first suite's pages keep the file as it is, where the
// https cases fail natively and drop out; these pages load this copy.
const HTTP_HELPER = '/cookies/resources/cookie-helper-http.sub.js';

const TRANSPARENT_GIF = Buffer.from(
	'47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
	'hex',
);

// after setting cookies: a same-site navigation, which sends every cookie,
// SameSite ones included (this page may have been reached from another site)
const NAVIGATE = `
<!DOCTYPE html>
<script>
  // A same-site navigation, which should attach all cookies including SameSite ones.
  // This is necessary because this page may have been reached via a cross-site navigation, so
  // we might not have access to some SameSite cookies from here.
  window.location = "../samesite/resources/echo-cookies.html";
</script>
`;

export default ({ root, setHeaders, substitute, cookiePairs }) => {
	/** helpers.py setNoCacheAndCORSHeaders */
	const noCacheAndCORS = (req) => [
		['Content-Type', 'application/json'],
		['Access-Control-Allow-Credentials', 'true'],
		['Access-Control-Allow-Origin', req.headers.origin ?? '*'],
		['Cache-Control', 'no-cache'],
		['Expires', 'Fri, 01 Jan 1990 00:00:00 GMT'],
	];
	/** helpers.py makeCookieHeader: the name first, a valueless attribute bare */
	const cookie = (name, value, attributes) => [
		'Set-Cookie',
		[
			`${name}=${value}`,
			...attributes.map(([key, attribute]) =>
				attribute === '' ? key : `${key}=${attribute}`,
			),
		].join('; '),
	];
	const drop = (name, secure) =>
		cookie(name, '', [
			['max-age', 0],
			['path', '/'],
			...(secure ? [['secure', '']] : []),
		]);
	/** wptserve sends each header a handler returns; the last Content-Type is the browser's */
	const send = (res, status, headers, body) => {
		const types = headers.filter(([name]) => name === 'Content-Type');
		res.statusCode = status;
		setHeaders(res, [
			...headers.filter(([name]) => name !== 'Content-Type'),
			types[types.length - 1],
		]);
		res.end(body);
	};
	const html = ['Content-Type', 'text/html; charset=utf-8'];
	/** the raw query string: the value of every cookie a set handler makes */
	const valueOf = (url) => url.search.slice(1);
	/** helpers.py readCookies: by name, the last of a name wins */
	const cookiesOf = (req) => Object.fromEntries(cookiePairs(req));

	const handlers = {
		'/cookies/resources/setSameSite.py': (req, res, url) => {
			const value = valueOf(url);
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					html,
					cookie('samesite_strict', value, [
						['SameSite', 'Strict'],
						['path', '/'],
					]),
					cookie('samesite_lax', value, [
						['SameSite', 'Lax'],
						['path', '/'],
					]),
					// SameSite=None cookies must be Secure
					cookie('samesite_none', value, [
						['SameSite', 'None'],
						['path', '/'],
						['Secure', ''],
					]),
					cookie('samesite_unspecified', value, [['path', '/']]),
				],
				NAVIGATE,
			);
		},
		'/cookies/resources/setSameSiteDomain.py': (req, res, url) => {
			const value = valueOf(url);
			const domain = ['domain', (req.headers.host ?? '').split(':')[0]];
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					html,
					cookie('samesite_strict', value, [
						['SameSite', 'Strict'],
						['path', '/'],
						domain,
					]),
					cookie('samesite_lax', value, [
						['SameSite', 'Lax'],
						['path', '/'],
						domain,
					]),
					cookie('samesite_none', value, [
						['SameSite', 'None'],
						['path', '/'],
						['Secure', ''],
						domain,
					]),
					cookie('samesite_unspecified', value, [['path', '/'], domain]),
				],
				NAVIGATE,
			);
		},
		'/cookies/resources/dropSameSite.py': (req, res) =>
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					drop('samesite_strict', false),
					drop('samesite_lax', false),
					drop('samesite_none', false),
					drop('samesite_unspecified', false),
				],
				'{"success": true}',
			),
		'/cookies/resources/setSameSiteNone.py': (req, res, url) => {
			const value = valueOf(url);
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					cookie('samesite_none_insecure', value, [
						['SameSite', 'None'],
						['path', '/'],
					]),
					cookie('samesite_none_secure', value, [
						['SameSite', 'None'],
						['Secure', ''],
						['path', '/'],
					]),
				],
				'{"success": true}',
			);
		},
		'/cookies/resources/dropSameSiteNone.py': (req, res) =>
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					drop('samesite_none_insecure', false),
					drop('samesite_none_secure', true),
				],
				'{"success": true}',
			),
		// The python handler writes each cookie's attributes as a dict with
		// the SameSite key twice, and a dict keeps one value per key: the
		// second, at the place of the first. So each cookie goes out with a
		// single SameSite attribute, and that is what is ported.
		'/cookies/resources/setSameSiteMultiAttribute.py': (req, res, url) => {
			const value = valueOf(url);
			const made = (name, sameSite, secure) =>
				cookie(name, value, [
					['SameSite', sameSite],
					['path', '/'],
					...(secure ? [['Secure', '']] : []),
				]);
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					html,
					made('samesite_unsupported', 'Unsupported', true),
					made('samesite_unsupported_none', 'None', true),
					made('samesite_unsupported_lax', 'Lax', false),
					made('samesite_unsupported_strict', 'Strict', false),
					made('samesite_none_unsupported', 'Unsupported', true),
					made('samesite_lax_unsupported', 'Unsupported', true),
					made('samesite_strict_unsupported', 'Unsupported', true),
					made('samesite_lax_none', 'None', true),
					made('samesite_lax_strict', 'Strict', false),
					made('samesite_strict_lax', 'Lax', false),
				],
				NAVIGATE,
			);
		},
		'/cookies/resources/dropSameSiteMultiAttribute.py': (req, res) =>
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					drop('samesite_unsupported', true),
					drop('samesite_unsupported_none', true),
					drop('samesite_unsupported_lax', false),
					drop('samesite_unsupported_strict', false),
					drop('samesite_none_unsupported', true),
					drop('samesite_lax_unsupported', true),
					drop('samesite_strict_unsupported', true),
					drop('samesite_lax_none', true),
				],
				'{"success": true}',
			),
		'/cookies/resources/setSecure.py': (req, res, url) => {
			const value = valueOf(url);
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					cookie('alone_secure', value, [
						['secure', ''],
						['path', '/'],
					]),
					cookie('alone_insecure', value, [['path', '/']]),
				],
				'{"success": true}',
			);
		},
		'/cookies/resources/dropSecure.py': (req, res) =>
			send(
				res,
				200,
				[
					...noCacheAndCORS(req),
					drop('alone_secure', false),
					drop('alone_insecure', false),
				],
				'{"success": true}',
			),
		// a document that posts the cookies its request carried, and the ones
		// its document.cookie shows, to its parent, its top and its opener
		'/cookies/resources/postToParent.py': (req, res) =>
			send(
				res,
				200,
				[...noCacheAndCORS(req), html],
				`
<!DOCTYPE html>
<script>
  var data = ${JSON.stringify(cookiesOf(req))};
  data.type = "COOKIES";

  try {
    data.domcookies = document.cookie;
  } catch (e) {}

  if (window.parent != window) {
    window.parent.postMessage(data, "*");
    if (window.top != window.parent)
      window.top.postMessage(data, "*");
  }


  if (window.opener)
    window.opener.postMessage(data, "*");

  window.addEventListener("message", e => {
    console.log(e);
    if (e.data == "reload")
      window.location.reload();
  });
</script>
`,
			),
		'/cookies/resources/redirectWithCORSHeaders.py': (req, res, url) =>
			send(
				res,
				Number(url.searchParams.get('status')) || 302,
				[
					...noCacheAndCORS(req),
					['Location', url.searchParams.get('location') ?? ''],
				],
				'',
			),
		// a transparent GIF when the request carries the cookie asked for
		'/cookies/resources/imgIfMatch.py': (req, res, url) => {
			const name = (url.searchParams.get('name') ?? '').trim();
			const value = (url.searchParams.get('value') ?? '').trim();
			const matches = cookiePairs(req).some(
				([key, held]) => key === name && held === value,
			);
			if (matches && name && value)
				return send(
					res,
					200,
					[...noCacheAndCORS(req), ['Content-Type', 'image/gif']],
					TRANSPARENT_GIF,
				);
			send(
				res,
				500,
				noCacheAndCORS(req),
				'{"error": {"message": "The cookie\'s value did not match the given value."}}',
			);
		},
		'/cookies/resources/list-cookies-for-script.py': (req, res) =>
			send(
				res,
				200,
				[...noCacheAndCORS(req), ['Content-Type', 'text/javascript']],
				`self._cookies = [${Object.keys(cookiesOf(req))
					.map((name) => `"${name}"`)
					.join(', ')}];\n`,
			),
		[HTTP_HELPER]: (req, res, url, port) => {
			res.statusCode = 200;
			setHeaders(res, [['Content-Type', 'text/javascript; charset=utf-8']]);
			res.end(
				substitute(readFileSync(root + HELPER.slice(1), 'utf8'), req, port)
					.replaceAll('"https://" + HOST', '"http://" + HOST')
					.replaceAll(
						'"https://" + CROSS_ORIGIN_HOST',
						'"http://" + CROSS_ORIGIN_HOST',
					),
			);
		},
	};

	// every page of the suite's directories loads the http copy of the helper
	const patches = {};
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const full = `${dir}/${name}`;
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith('.html'))
				patches[`/${full.slice(root.length)}`] = [[HELPER, HTTP_HELPER]];
		}
	};
	for (const dir of DIRS) walk(`${root}cookies/${dir}`);
	return { handlers, patches };
};
