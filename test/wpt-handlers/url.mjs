// The wptserve pieces the vendored url/ tests need (test/wpt/lists/url.mjs).
export default ({ setHeaders }) => ({
	handlers: {
		// url/resources/percent-encoding.py: an anchor whose query and fragment
		// are the base64 `value`, written as numeric character references in a
		// document of the `encoding` asked for, so the HTML parser and not the
		// server picks the bytes
		'/url/resources/percent-encoding.py': (req, res, url) => {
			// the query's "+" arrives as a space; undo it before decoding
			const value = (url.searchParams.get('value') ?? '').replace(/ /g, '+');
			const text = Buffer.from(value, 'base64').toString('utf8');
			const references = [...text]
				.map((char) => `&#x${char.codePointAt(0).toString(16).toUpperCase()};`)
				.join('');
			res.statusCode = 200;
			setHeaders(res, [
				[
					'Content-Type',
					`text/html;charset=${url.searchParams.get('encoding') ?? ''}`,
				],
			]);
			res.end(
				`<!doctype html>\n<a href="https://doesnotmatter.invalid/?${references}#${references}">test</a>\n`,
			);
		},
	},
});
