/**
 * Chrome's interstitial for a form an https page submits to http at the
 * top level ("Form is not secure", chrome-error://chromewebdata/ natively,
 * measured in Chrome 152): nothing is sent until the user picks "Send
 * anyway", which submits the same fields to `routed` (the plain document
 * route, which goes out as is), or "Go back".
 */

const escapeHTML = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				c
			]!,
	);

/** the fields a submission carries, when its body is one the page can send again (no files) */
export async function formFields(
	request: Request,
): Promise<[string, string][] | null> {
	if (request.method === 'GET' || request.method === 'HEAD') return [];
	const type = request.headers.get('content-type') ?? '';
	if (
		!type.startsWith('application/x-www-form-urlencoded') &&
		!type.startsWith('multipart/form-data')
	)
		return null;
	try {
		const fields: [string, string][] = [];
		for (const [name, value] of await request.clone().formData())
			if (typeof value === 'string') fields.push([name, value]);
			else return null;
		return fields;
	} catch (error) {
		return null;
	}
}

export function insecureFormPage(
	routed: string,
	method: string,
	fields: [string, string][] | null,
	enctype: string,
): Response {
	const send =
		fields === null
			? ''
			: `<form method="${method === 'GET' ? 'get' : 'post'}" action="${escapeHTML(routed)}" enctype="${escapeHTML(enctype)}">${fields
					.map(
						([name, value]) =>
							`<input type="hidden" name="${escapeHTML(name)}" value="${escapeHTML(value)}">`,
					)
					.join(
						'',
					)}<button type="submit" id="proceed-button">Send anyway</button></form>`;
	return new Response(
		`<!doctype html><html dir="ltr" lang="en"><head><meta charset="utf-8"><meta name="viewport" content="initial-scale=1, minimum-scale=1, width=device-width"><title>Form is not secure</title><style>body{font-family:system-ui,sans-serif;color:#202124;margin:0;padding:14vh 24px 0}main{max-width:600px;margin:0 auto}h1{font-size:1.6em;font-weight:normal;line-height:1.25}p{line-height:1.6;font-size:15px}.nav{display:flex;gap:12px;justify-content:flex-end;margin-top:48px}button{font:inherit;font-size:14px;border-radius:4px;padding:8px 16px;cursor:pointer}#primary-button{background:#1a73e8;color:#fff;border:0}#proceed-button{background:#fff;color:#1a73e8;border:1px solid #dadce0}</style></head><body><main><h1>The information you&rsquo;re about to submit is not secure</h1><p>Because this form is being submitted using a connection that&rsquo;s not secure, your information will be visible to others.</p><div class="nav">${send}<button id="primary-button" type="button" onclick="history.back()">Go back</button></div></main></body></html>`,
		{
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			},
		},
	);
}
