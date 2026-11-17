// The HTML parser differential fuzz (test/parserFuzz.mjs): documents whose
// markup Chrome's tokenizer and tree builder read in a way a rewriter can
// miss. Script types and languages, raw text and escaped script content,
// comments that end early, foreign content (SVG and MathML, their
// breakout tags, xlink:href, CDATA, an SVG <script>), templates and
// declarative shadow roots, noscript, the new <select> content model,
// entities in URL attributes (a javascript: URL spelled with them),
// duplicate and oddly written attributes, srcset's grammar, <base href>
// before and after URLs, meta refresh's grammar, every <link> rel that
// loads, every element that fetches, srcdoc inside srcdoc, quirks-mode
// doctypes, and XHTML and SVG documents. Each case is a document of its
// own in a frame of the batch page; what Chrome fetched and ran natively
// is what the proxy must fetch and run, and nothing may go past it or run
// unrewritten. A script reports by loading a URL that says what it saw as
// `location` and `top`: code that ran unrewritten saw the proxy's.
import {
	attr,
	doneScript,
	headScript,
	js,
	prng,
	runDifferential,
} from '../parserFuzz.mjs';

const SEED = 0x47a1;
const SCALE = Number(process.env.FZ_SCALE || 1);
const PER_BATCH = 24;

/** code that reports it ran: what it saw as location and top */
const payload = (s, id, k = 0) =>
	`(function(){var l='x',t='x';try{l=location.href}catch(e){}try{t=top.location.href}catch(e){}(new Image).src=${js(`${s.origin}/fz/${id}/ran-${k}.png?l=`)}+encodeURIComponent(l)+'&t='+encodeURIComponent(t)})()`;
/** the same, as an attribute value (double quotes) */
const payloadAttr = (s, id, k) => attr(payload(s, id, k));

// --- the families of cases; each returns { doc, files?, type? } for (s, id, r) ---

const SCRIPT_TYPES = [
	'',
	'text/javascript',
	' text/javascript ',
	'TEXT/JAVASCRIPT',
	'text/javascript; charset=utf-8',
	'text/javascript;',
	'application/javascript',
	'application/x-javascript',
	'application/ecmascript',
	'text/ecmascript',
	'text/x-ecmascript',
	'text/x-javascript',
	'text/jscript',
	'text/livescript',
	'text/javascript1.0',
	'text/javascript1.5',
	'text/javascript1.6',
	'module',
	' module ',
	'MODULE',
	'\tmodule\n',
	'text/plain',
	'text/html',
	'importmap',
	'speculationrules',
	'jscript',
	'javascript',
	'application/json',
	'text/babel',
	'text/javascript\u00a0',
	'text/javascript\u000c',
];
const SCRIPT_LANGUAGES = [
	'',
	'javascript',
	'JavaScript1.2',
	'jscript',
	'ecmascript',
	'livescript',
	'vbscript',
	'javascript1.6',
	'text/javascript',
];

// the sniff cases: [Content-Type (null: none), extra headers, body of the payload]
const SNIFF_TAGS = [
	'!DOCTYPE html',
	'script',
	'html',
	'!--',
	'head',
	'iframe',
	'h1',
	'div',
	'font',
	'table',
	'a',
	'style',
	'title',
	'b',
	'body',
	'br',
	'p',
];
const UNKNOWN_TYPES = [
	null,
	'',
	'unknown/unknown',
	'application/unknown',
	'*/*',
	'html',
	'Unknown/Unknown',
	' application/unknown ; charset=utf-8',
];
const run = (p) => `<script>${p}</script>`;
/** a body that starts with `<tag` + `end` and then runs the payload */
const opening =
	(tag, end = '>', before = '') =>
	(p) =>
		tag === 'script'
			? `${before}<script${end}${p}</script>`
			: tag === '!--'
				? `${before}<!--${end === '>' ? ' x -->' : `${end}x -->`}${run(p)}`
				: `${before}<${tag}${end}${['style', 'title', 'iframe'].includes(tag) ? `</${tag}>` : ''}${run(p)}`;
const NOSNIFF = { 'x-content-type-options': 'nosniff' };
const MIME_SNIFF_CASES = [
	// every tag of the table under every unknown type
	...UNKNOWN_TYPES.flatMap((type) =>
		SNIFF_TAGS.map((tag) => [type, undefined, opening(tag)]),
	),
	// what may follow the tag's name (the tag still closes, so its
	// payload runs wherever it is read as HTML)
	...[' >', '\t>', '\n>', '\f>', '\r>', '/>', 'x>', '!>', '\0>'].flatMap(
		(end) => [
			['unknown/unknown', undefined, opening('html', end)],
			[null, undefined, opening('b', end)],
			['', undefined, opening('br', end)],
		],
	),
	['unknown/unknown', undefined, (p) => `<!--x-->${run(p)}`],
	['unknown/unknown', undefined, (p) => `<!---->${run(p)}`],
	['unknown/unknown', undefined, (p) => `<!DOCTYPE  html>${run(p)}`],
	[null, undefined, () => ''],
	['', undefined, () => ' '],
	['unknown/unknown', undefined, () => ''],
	// what may come before it, and how far into the body it may be
	...[
		' \t\n\r\f',
		'\v',
		' ',
		'﻿',
		'\0',
		'x',
		' '.repeat(500),
		' '.repeat(506),
		' '.repeat(507),
		' '.repeat(508),
		'\n'.repeat(510),
		' '.repeat(1000),
		' '.repeat(1030),
	].flatMap((before) => [
		['unknown/unknown', undefined, opening('html', '>', before)],
		[null, undefined, opening('script', '>', before)],
	]),
	// case, and a doctype that is not html's
	['unknown/unknown', undefined, (p) => `<HtMl>${run(p)}`],
	['unknown/unknown', undefined, (p) => `<!doctype HTML>${run(p)}`],
	['unknown/unknown', undefined, (p) => `<!DOCTYPE htmlx>${run(p)}`],
	['unknown/unknown', undefined, (p) => `<!DOCTYPE svg>${run(p)}`],
	['unknown/unknown', undefined, (p) => `<SCRIPT>${p}</SCRIPT>`],
	['*/*', undefined, (p) => `<IFRAME></IFRAME>${run(p)}`],
	// a tag not in the table
	['unknown/unknown', undefined, (p) => `<span>${run(p)}`],
	[null, undefined, (p) => `<svg>${run(p)}`],
	[null, undefined, (p) => `hello ${run(p)}`],
	// nosniff: the browser takes the type as it is
	...[
		null,
		'',
		' ',
		'unknown/unknown',
		'application/unknown',
		'*/*',
		'html',
		';charset=utf-8',
	].flatMap((type) => [
		[type, NOSNIFF, opening('html')],
		[type, NOSNIFF, opening('script')],
	]),
	// types the sniff leaves alone
	['unknown/unknown', { 'x-content-type-options': 'NoSniff' }, opening('p')],
	[null, { 'x-content-type-options': 'nosniff, x' }, opening('p')],
	[null, { 'x-content-type-options': 'no-sniff' }, opening('p')],
	[' ', undefined, opening('p')],
	[';charset=utf-8', undefined, opening('p')],
	['text/', undefined, opening('p')],
	['/html', undefined, opening('p')],
	// a list of types: Chrome takes the last it can parse
	['text/plain, unknown/unknown', undefined, opening('p')],
	['unknown/unknown, text/plain', undefined, opening('p')],
	['text/html, */*', undefined, opening('p')],
	['*/*, text/plain', undefined, opening('p')],
	['text/plain, html', undefined, opening('p')],
	['text/plain', undefined, opening('html')],
	['text/plain', undefined, opening('script')],
	['TEXT/PLAIN', undefined, opening('html')],
	['text/html', undefined, opening('p')],
	['text/html', undefined, opening('!--')],
	['text/html', NOSNIFF, opening('p')],
];

const families = {
	// <script type> and <script language>: Chrome runs what it takes for
	// JavaScript; a script the rewriter takes for data runs unrewritten
	'script-type': (s, id, r) => {
		const type = r.pick(SCRIPT_TYPES);
		return {
			doc: `<script type="${attr(type)}">${payload(s, id)}</script>`,
			tag: `type=${JSON.stringify(type)}`,
		};
	},
	'script-language': (s, id, r) => {
		const language = r.pick(SCRIPT_LANGUAGES);
		const type =
			r.next() < 0.3
				? ` type="${r.pick(['', 'text/javascript', 'module'])}"`
				: '';
		return {
			doc: `<script language="${attr(language)}"${type}>${payload(s, id)}</script>`,
			tag: `language=${JSON.stringify(language)}${type}`,
		};
	},
	'script-src-type': (s, id, r) => {
		const type = r.pick(SCRIPT_TYPES);
		return {
			doc: `<script type="${attr(type)}" src="/fz/${id}/s.js"></script>`,
			files: {
				[`/fz/${id}/s.js`]: { type: 'text/javascript', body: payload(s, id) },
			},
			tag: `type=${JSON.stringify(type)}`,
		};
	},
	'script-for-event': (s, id, r) => {
		const [f, e] = r.pick([
			['window', 'onload'],
			['window', 'onload()'],
			['WINDOW', 'ONLOAD'],
			['document', 'onload'],
			['x', 'y'],
			['window', 'onclick'],
		]);
		return {
			doc: `<script for="${f}" event="${e}">${payload(s, id)}</script>`,
			tag: `for=${f} event=${e}`,
		};
	},
	'script-nomodule': (s, id, r) => {
		const t = r.pick(['', ' type="module"']);
		return { doc: `<script nomodule${t}>${payload(s, id)}</script>`, tag: t };
	},
	// what a script's text is: the tokenizer's script data states
	'script-content': (s, id, r) => {
		const p = payload(s, id);
		const q = payload(s, id, 1);
		const shape = r.pick([
			`<script><!--\n${p}\n--></script>`,
			`<script><!--<script>\n${p}\n</script>\n${q}\n--></script><script>${q}</script>`,
			`<script>'<!--<script>';${p}</script><script>${q}</script>`,
			`<script>/*</script>*/${p}</script>`,
			`<script>${p}</SCRIPT >${q}`,
			`<script>${p}</script\t>`,
			`<script>${p}</script/x>`,
			`<script>a='<\\/script>';${p}</script>`,
			`<script>a="</scr"+"ipt>";${p}</script>`,
			`<script>-->${p}\n${q}</script>`,
			`<script>\n-->${p}\n${q}</script>`,
			`<script>${p}<!--</script>${q}`,
			`<script type="module"><!--\n${p}\n--></script><script>${q}</script>`,
			`<script>${p}//</script><img src="/fz/${id}/after.png">`,
			`<script>${p}\u2028${q}</script>`,
			`<script>${p}\u0000</script>`,
		]);
		return {
			doc: shape,
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 80),
		};
	},
	// raw text, RCDATA and the elements whose content is never markup
	'raw-text': (s, id, r) => {
		const img = `<img src="${s.origin}/fz/${id}/0.png">`;
		const p = `<script>${payload(s, id)}</script>`;
		const inner = r.next() < 0.5 ? img : p;
		const shape = r.pick([
			`<textarea>${inner}</textarea>`,
			`<title>${inner}</title>`,
			`<xmp>${inner}</xmp>`,
			`<noembed>${inner}</noembed>`,
			`<noframes>${inner}</noframes>`,
			`<iframe>${inner}</iframe>`,
			`<style>${inner}</style>`,
			`<noscript>${inner}</noscript>`,
			`<noscript><p title="</noscript>${inner}"></noscript>`,
			`<noscript><style></noscript>${inner}</style></noscript>`,
			`<template>${inner}</template>`,
			`<plaintext>${inner}`,
			`<textarea></textarea >${inner}</textarea>`,
			`<title></title/>${inner}`,
			`<xmp></xmp >${inner}`,
			`<textarea><!--</textarea>-->${inner}`,
			`<style><!--</style>${inner}--></style>`,
			`<iframe><!--</iframe>${inner}--></iframe>`,
			`<noembed><!--</noembed>${inner}--></noembed>`,
			`<object><param name=x>${inner}</object>`,
		]);
		return {
			doc: shape,
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 80),
		};
	},
	// comments the tokenizer ends early, and the bogus ones
	comment: (s, id, r) => {
		const inner =
			r.next() < 0.5
				? `<img src="${s.origin}/fz/${id}/0.png">`
				: `<script>${payload(s, id)}</script>`;
		const shape = r.pick([
			`<!-->${inner}-->`,
			`<!--->${inner}-->`,
			`<!-- --!>${inner} -->`,
			`<!-- -- >${inner} -->`,
			`<!-- --!->${inner} -->`,
			`<! foo>${inner}`,
			`<?x>${inner}`,
			`</ x>${inner}`,
			`</>${inner}`,
			`<!--<!-->${inner}-->`,
			`<!---- >${inner}-->`,
			`<![CDATA[x]]>${inner}`,
			`<![CDATA[${inner}]]>`,
			`<!doctype html><!--${inner}--!>`,
			`<!--${inner}`,
			`<!-- a -- b -->${inner}`,
		]);
		return {
			doc: shape,
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 80),
		};
	},
	// SVG and MathML: breakout tags, integration points, raw text that is
	// markup there, CDATA, an SVG script
	foreign: (s, id, r) => {
		const img = `<img src="${s.origin}/fz/${id}/0.png">`;
		const p = payload(s, id);
		const shape = r.pick([
			`<svg><style>${img}</style></svg>`,
			`<math><style>${img}</style></math>`,
			`<svg><title>${img}</title></svg>`,
			`<svg><desc><img src="${s.origin}/fz/${id}/0.png"></desc></svg>`,
			`<math><mtext>${img}</mtext></math>`,
			`<math><mi><mglyph><style>${img}</style></mglyph></mi></math>`,
			`<math><annotation-xml encoding="text/html">${img}</annotation-xml></math>`,
			`<math><annotation-xml>${img}</annotation-xml></math>`,
			`<svg><foreignObject>${img}</foreignObject></svg>`,
			`<svg><![CDATA[</svg>${img}]]></svg>`,
			`<svg><image href="${s.origin}/fz/${id}/0.png"/></svg>`,
			`<svg><image xlink:href="${s.origin}/fz/${id}/0.png"/></svg>`,
			`<svg><image XLINK:HREF="/fz/${id}/0.png"/></svg>`,
			`<svg><image xlink:href="${s.origin}/fz/${id}/0.png" href="${s.origin}/fz/${id}/1.png"/></svg>`,
			`<svg><image href="${s.origin}/fz/${id}/1.png" xlink:href="${s.origin}/fz/${id}/0.png"/></svg>`,
			`<svg><feImage href="${s.origin}/fz/${id}/0.png"/></svg>`,
			`<svg width="9" height="9"><filter id="ff"><feImage xlink:href="${s.origin}/fz/${id}/0.png"/></filter><rect width="9" height="9" filter="url(#ff)"/></svg>`,
			`<svg><use href="${s.origin}/fz/${id}/u.svg#r"/></svg>`,
			`<svg><use xlink:href="${s.origin}/fz/${id}/u.svg#r"/></svg>`,
			`<svg><script>${p}</script></svg>`,
			`<svg><script><![CDATA[${p}]]></script></svg>`,
			`<svg><script>${p.replace(/'/g, '&apos;')}</script></svg>`,
			`<svg><script href="${s.origin}/fz/${id}/s.js"></script></svg>`,
			`<svg><script xlink:href="${s.origin}/fz/${id}/s.js"></script></svg>`,
			`<svg><script type="text/ecmascript">${p}</script></svg>`,
			`<svg><script type="text/plain">${p}</script></svg>`,
			`<svg onload="${attr(p)}"></svg>`,
			`<svg><style>@import url(${s.origin}/fz/${id}/i.css);</style></svg>`,
			`<svg><style>&#x40;import url(${s.origin}/fz/${id}/i.css);</style></svg>`,
			`<svg><a><script>${p}</script></a></svg>`,
			`<math><script>${p}</script></math>`,
			`<svg><p>${img}</p></svg>`,
			`<svg><font color=red>${img}</font></svg>`,
			`<svg><font>${img}</font></svg>`,
			`<math><mtext><table><mglyph><style>${img}</style></mglyph></table></mtext></math>`,
			`<svg></p>${img}</svg>`,
			`<svg><animate attributeName="href" to="/fz/${id}/0.png"/></svg>`,
		]);
		return {
			doc: shape,
			files: {
				[`/fz/${id}/s.js`]: { type: 'text/javascript', body: p },
				[`/fz/${id}/i.css`]: {
					type: 'text/css',
					body: `body{background-image:url(sub.png)}`,
				},
			},
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 90),
		};
	},
	// templates, declarative shadow roots, the customizable select
	'shadow-select': (s, id, r) => {
		const img = `<img src="${s.origin}/fz/${id}/0.png">`;
		const p = `<script>${payload(s, id)}</script>`;
		const shape = r.pick([
			`<div><template shadowrootmode="open">${img}</template></div>`,
			`<div><template shadowrootmode="closed">${p}</template></div>`,
			`<div><template shadowrootmode="open"><slot></slot></template>${img}</div>`,
			`<div><template shadowrootmode="OPEN">${img}</template></div>`,
			`<div><template shadowroot="open">${img}</template></div>`,
			`<div><template shadowrootmode="open"><style>@import url(${s.origin}/fz/${id}/i.css);</style></template></div>`,
			`<div><template shadowrootmode="open"><template shadowrootmode="open">${img}</template></template></div>`,
			`<template><template shadowrootmode="open">${img}</template></template>`,
			`<select><img src="${s.origin}/fz/${id}/0.png"></select>`,
			`<select><button><img src="${s.origin}/fz/${id}/0.png"></button><option>a</option></select>`,
			`<select><option><img src="${s.origin}/fz/${id}/0.png">a</option></select>`,
			`<select>${p}<option>a</option></select>`,
			`<select><svg><image href="${s.origin}/fz/${id}/0.png"/></svg></select>`,
			`<select><textarea>${img}</textarea></select>`,
			`<table>${img}</table>`,
			`<table><tr>${p}<td>x</td></tr></table>`,
			`<table><form><input type="image" src="${s.origin}/fz/${id}/0.png"></form></table>`,
			`<a href="x"><table><a href="y">${img}</a></table></a>`,
			`<form><form>${img}</form></form>`,
			`<frameset><frame src="${s.origin}/fz/${id}/f.html"></frameset>`,
		]);
		return {
			doc: shape,
			files: {
				[`/fz/${id}/i.css`]: {
					type: 'text/css',
					body: `body{background-image:url(sub.png)}`,
				},
			},
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 90),
		};
	},
	// a javascript: URL in a frame, spelled with entities, controls and case
	'js-url-entities': (s, id, r) => {
		const p = payload(s, id);
		const scheme = r.pick([
			'javascript:',
			'JaVaScRiPt:',
			' javascript:',
			'\tjavascript:',
			'\njavascript:',
			'java\tscript:',
			'java\nscript:',
			'java\rscript:',
			'&#x01;javascript:',
			'&#x0;javascript:',
			'&#106;avascript:',
			'&#x6A;avascript:',
			'&#106avascript:',
			'javascript&colon;',
			'javascript&#58;',
			'javascript&#x3a;',
			'javascript&#x3A',
			'javascript&colon',
			'jav&#x09;ascript:',
			'jav&#x0A;ascript:',
			'jav&Tab;ascript:',
			'jav&NewLine;ascript:',
			'&#x20;javascript:',
			'\u00a0javascript:',
			'&nbsp;javascript:',
			'javascript\u0000:',
			'javascript :',
			'javascript:\u2028',
			'%6Aavascript:',
			'javascript%3a',
		]);
		const where = r.pick([
			'iframe-src',
			'object-data',
			'embed-src',
			'frame-src',
			'meta-refresh',
			'form-action-submit',
			'a-click',
		]);
		const body = scheme + p.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
		const doc = {
			'iframe-src': `<iframe src="${body}"></iframe>`,
			'object-data': `<object data="${body}"></object>`,
			'embed-src': `<embed src="${body}">`,
			'frame-src': `<frameset><frame src="${body}"></frameset>`,
			'meta-refresh': `<meta http-equiv="refresh" content="0;url=${body}">`,
			'form-action-submit': `<form action="${body}"></form><script>document.forms[0].submit()</script>`,
			'a-click': `<a href="${body}" id="a">x</a><script>document.getElementById('a').click()</script>`,
		}[where];
		return { doc, tag: `${where} ${JSON.stringify(scheme)}` };
	},
	// entities and odd spellings in URL attributes
	'attr-entities': (s, id, r) => {
		const path = `/fz/${id}/0.png`;
		const spelled = r.pick([
			path.replace(/\//g, '&#x2f;'),
			path.replace(/\//g, '&sol;'),
			path.replace(/\./, '&period;'),
			path.replace(/\./, '&#46'),
			path.replace('fz', '&#102z'),
			`&#x20;${path}`,
			`${path}&#x09;`,
			path.replace(/\/0/, '/&#x09;0'),
			path.replace(/\/0/, '/&#x0a;0'),
			path.replace('/fz', '/f&#x0d;z'),
			`http:&#x5c;&#x5c;127.0.0.1:${s.port}${path}`,
			`${s.origin.replace('http:', 'http&colon;')}${path}`,
			`${path}?a=1&amp;b=2`,
			`${path}?a=1&b=2&copy=3`,
			`${path}?a=1&not=2`,
			`${path}?x&notin;y`,
			`${path}?a=&lt;b&gt;`,
		]);
		const el = r.pick([
			(v) => `<img src="${v}">`,
			(v) => `<img src='${v}'>`,
			(v) => `<img src=${v.replace(/[\s"'=<>`]/g, '')}>`,
			(v) => `<input type="image" src="${v}">`,
			(v) => `<video poster="${v}"></video>`,
			(v) => `<link rel="stylesheet" href="${v.replace('.png', '.css')}">`,
			(v) => `<script src="${v.replace('.png', '.js')}"></script>`,
			(v) => `<iframe src="${v.replace('.png', '.html')}"></iframe>`,
			(v) => `<body background="${v}"></body>`,
			(v) => `<svg><image href="${v}"/></svg>`,
		]);
		const doc = el(spelled);
		return { doc, tag: doc.slice(0, 90) };
	},
	// attributes written twice, in odd ways, or with odd names
	'attr-odd': (s, id, r) => {
		const a = `/fz/${id}/0.png`;
		const b = `/fz/${id}/1.png`;
		const shape = r.pick([
			`<img src="${a}" src="${b}">`,
			`<img src="${a}" SRC="${b}">`,
			`<img SRC="${a}">`,
			`<IMG SRC="${a}">`,
			`<img/src="${a}">`,
			`<img src="${a}"/src="${b}">`,
			`<img a=b/src="${a}">`,
			`<img a="x"src="${a}">`,
			`<img\nsrc\n=\n"${a}">`,
			`<img src = ${a} >`,
			`<img src=${a}/>`,
			`<img """ src="${a}">`,
			`<img src="${a}" srcset="${b} 2x">`,
			`<img srcset="${b} 1x" src="${a}">`,
			`<image src="${a}">`,
			`<img lowsrc="${a}">`,
			`<img src="" srcset="${a}">`,
			`<img src=" ">`,
			`<img data-src="${a}">`,
			`<img src="${a}" loading="lazy">`,
			`<img src="${a}" crossorigin>`,
			`<img src="${a}" srcset="">`,
			`<script src="/fz/${id}/s.js" src="/fz/${id}/t.js"></script>`,
			`<iframe src="/fz/${id}/f.html" src="/fz/${id}/g.html"></iframe>`,
			`<iframe srcdoc="<img src=${a}>" srcdoc="<img src=${b}>"></iframe>`,
			`<img src="${a}" onerror="${payloadAttr(s, id)}" onerror="x">`,
			`<img src="/fz/${id}/bad.woff2" ONERROR="${payloadAttr(s, id)}">`,
			`<img src="/fz/${id}/bad.woff2" onerror = "${payloadAttr(s, id)}">`,
			`<img src="/fz/${id}/bad.woff2" onerror="${payloadAttr(s, id).replace(/'/g, '&apos;').replace(/\(/g, '&lpar;')}">`,
			`<img src="/fz/${id}/bad.woff2" o\u0000nerror="${payloadAttr(s, id)}">`,
			`<img src="/fz/${id}/bad.woff2"/onerror="${payloadAttr(s, id)}">`,
			`<body onload="${payloadAttr(s, id)}"></body>`,
			`<body><body onload="${payloadAttr(s, id)}"></body>`,
			`<details open ontoggle="${payloadAttr(s, id)}"><summary>x</summary></details>`,
			`<svg><set attributeName="onload" to="${payloadAttr(s, id)}"/></svg>`,
		]);
		return {
			doc: shape,
			files: {
				[`/fz/${id}/s.js`]: {
					type: 'text/javascript',
					body: payload(s, id, 1),
				},
				[`/fz/${id}/t.js`]: {
					type: 'text/javascript',
					body: payload(s, id, 2),
				},
			},
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 90),
		};
	},
	// srcset's grammar: commas inside URLs, descriptors, whitespace
	srcset: (s, id, r) => {
		const p = (n) => `/fz/${id}/${n}.png`;
		const value = r.pick([
			`${p(0)} 1x, ${p(1)} 2x`,
			`${p(0)},${p(1)} 2x`,
			`${p(0)}, ${p(1)} 2x`,
			`/fz/${id}/a,b.png 1x`,
			`/fz/${id}/a,b.png`,
			`/fz/${id}/a.png,, ${p(1)} 2x`,
			`,${p(0)} 1x`,
			` ${p(0)}\t1x ,\n${p(1)} 2x `,
			`${p(0)} 1x,${p(1)} 1x`,
			`${p(0)} 100w`,
			`${p(0)} 100w, ${p(1)} 1000w`,
			`${p(0)} 1x (min-width: 1px)`,
			`${p(0)} 1X`,
			`${p(0)} 1.0x`,
			`${p(0)} 1e0x`,
			`${p(0)} 0.5x, ${p(1)} 1x`,
			`data:image/png;base64,iVBORw0KGgo= 2x, ${p(0)} 1x`,
			`data:image/svg+xml,a,b 2x, ${p(0)} 1x`,
			`${p(0)}?a=1,2 1x`,
			`${p(0)} 1x foo`,
			`${p(0)}#a,b 1x`,
			`${p(0)}\u00a01x`,
			`'${p(0)}' 1x`,
			`${p(0)} 1h`,
		]);
		const el = r.pick([
			(v) => `<img srcset="${attr(v)}">`,
			(v) => `<img srcset="${attr(v)}" sizes="1px">`,
			(v) =>
				`<picture><source srcset="${attr(v)}"><img src="/fz/${id}/fallback.png"></picture>`,
			(v) =>
				`<picture><source srcset="${attr(v)}" media="(min-width: 1px)"><img></picture>`,
			(v) =>
				`<picture><source srcset="${attr(v)}" type="image/x-unknown"><img src="/fz/${id}/fallback.png"></picture>`,
			(v) =>
				`<link rel="preload" as="image" imagesrcset="${attr(v)}" imagesizes="1px">`,
			(v) => `<svg><image href="${attr(v.split(/\s/)[0])}"/></svg>`,
		]);
		const doc = el(value);
		return { doc, tag: doc.slice(0, 100) };
	},
	// <base href>: where it is, how many, how written
	base: (s, id, r) => {
		const shape = r.pick([
			`<base href="/fz/${id}/b/"><img src="x.png">`,
			`<img src="x.png"><base href="/fz/${id}/b/">`,
			`<base href="/fz/${id}/b/"><base href="/fz/${id}/c/"><img src="x.png">`,
			`<base target="_self"><base href="/fz/${id}/b/"><img src="x.png">`,
			`<base href=" /fz/${id}/b/ "><img src="x.png">`,
			`<base href="//127.0.0.1:${s.port}/fz/${id}/b/"><img src="x.png">`,
			`<base href="${s.other}/fz/${id}/b/"><img src="x.png">`,
			`<base href="javascript:alert(1)//"><img src="x.png">`,
			`<base href="data:text/html,x/"><img src="x.png">`,
			`<base href="about:blank"><img src="x.png">`,
			`<base href="/fz/${id}/b/x.html"><img src="y.png">`,
			`<base href=""><img src="x.png">`,
			`<base href="?q"><img src="x.png">`,
			`<base href="#h"><img src="x.png">`,
			`<base href="/fz/${id}/b/"><link rel="stylesheet" href="s.css">`,
			`<base href="/fz/${id}/b/"><script src="s.js"></script>`,
			`<base href="/fz/${id}/b/"><style>body{background-image:url(x.png)}</style>`,
			`<base href="/fz/${id}/b/"><iframe srcdoc="<img src=x.png>"></iframe>`,
			`<base href="/fz/${id}/b/"><img srcset="x.png 1x">`,
			`<base href="/fz/${id}/b/"><svg><image href="x.png"/></svg>`,
			`<base href="/fz/${id}/b/"><script>document.querySelector('base').href = '/fz/${id}/c/'; document.body.append(Object.assign(document.createElement('img'), { src: 'x.png' }));</script>`,
			`<body><img src="x.png"><base href="/fz/${id}/b/"><img src="y.png"></body>`,
			`<svg><base href="/fz/${id}/b/"/></svg><img src="x.png">`,
			`<template><base href="/fz/${id}/b/"></template><img src="x.png">`,
			`<base href="/fz/${id}/b/"><meta http-equiv="refresh" content="0;url=r.html">`,
		]);
		return {
			doc: shape,
			files: {
				[`/fz/${id}/b/s.css`]: {
					type: 'text/css',
					body: 'body{background-image:url(sub.png)}',
				},
			},
			tag: shape.slice(0, 100),
		};
	},
	// meta refresh's grammar
	'meta-refresh': (s, id, r) => {
		const t = `/fz/${id}/r.html`;
		const content = r.pick([
			`0;url=${t}`,
			`0; URL=${t}`,
			`0;url='${t}'`,
			`0;url="${t}"`,
			`0 url=${t}`,
			`0,url=${t}`,
			`0;${t}`,
			`0; ${t}`,
			`0.5;url=${t}`,
			`.0;url=${t}`,
			`0.;url=${t}`,
			`  0  ;  url = '${t}'  `,
			`0;url=&quot;${t}&quot;`,
			`0;url='${t}`,
			`0;url=${t}'trailing`,
			`0;url = ${t}`,
			`0;URL  =${t}`,
			`0;u=${t}`,
			`0;url=${t} spaces after`,
			`1e0;url=${t}`,
			`+0;url=${t}`,
			`-1;url=${t}`,
			`0;url=${s.other}${t}`,
			`0;url=//127.0.0.1:${s.port}${t}`,
			`0;url=data:text/html,<script>${payload(s, id)}</script>`,
			`0;url=javascript:${payload(s, id)}`,
			`0;\turl=${t}`,
			`0;url=\t${t}`,
			`0\n;url=${t}`,
		]);
		const equiv = r.pick(['refresh', 'REFRESH', ' refresh', 'Refresh']);
		const doc = `<meta http-equiv="${equiv}" content="${attr(content)}">`;
		return { doc, tag: doc.slice(0, 100) };
	},
	// every <link> that loads
	link: (s, id, r) => {
		const shape = r.pick([
			`<link rel="preload" as="image" href="/fz/${id}/0.png">`,
			`<link rel="preload" as="script" href="/fz/${id}/s.js">`,
			`<link rel="preload" as="style" href="/fz/${id}/s.css">`,
			`<link rel="preload" as="font" crossorigin href="/fz/${id}/f.woff2">`,
			`<link rel="preload" as="fetch" crossorigin href="/fz/${id}/d.json">`,
			`<link rel="preload" as="track" href="/fz/${id}/t.vtt">`,
			`<link rel="preload" as="IMAGE" href="/fz/${id}/0.png">`,
			`<link rel="preload" href="/fz/${id}/0.png">`,
			`<link rel="PRELOAD" as="image" href="/fz/${id}/0.png">`,
			`<link rel="modulepreload" href="/fz/${id}/m.mjs">`,
			`<link rel="modulepreload" as="script" href="/fz/${id}/m.mjs">`,
			`<link rel="prefetch" href="/fz/${id}/p.txt">`,
			`<link rel="icon" href="/fz/${id}/0.png">`,
			`<link rel="manifest" href="/fz/${id}/m.json">`,
			`<link rel="stylesheet" href="/fz/${id}/s.css" media="print">`,
			`<link rel="stylesheet" href="/fz/${id}/s.css" media="not all">`,
			`<link rel="stylesheet" href="/fz/${id}/s.css" disabled>`,
			`<link rel="alternate stylesheet" title="x" href="/fz/${id}/s.css">`,
			`<link rel=" STYLESHEET " href="/fz/${id}/s.css">`,
			`<link rel="stylesheet\tpreload" href="/fz/${id}/s.css">`,
			`<link rel="stylesheet" type="text/plain" href="/fz/${id}/s.css">`,
			`<link rel="stylesheet" type="TEXT/CSS" href="/fz/${id}/s.css">`,
			`<link rel="stylesheet" type="text/css; charset=utf-8" href="/fz/${id}/s.css">`,
			`<link rel="stylesheet" href="/fz/${id}/s.css" blocking="render">`,
			`<link rel="stylesheet" href=" /fz/${id}/s.css ">`,
			`<link rel="stylesheet" href="">`,
			`<link rel="compression-dictionary" href="/fz/${id}/dict.txt">`,
			`<link rel="dictionary" href="/fz/${id}/dict.txt">`,
			`<link rel="prerender" href="/fz/${id}/p.html">`,
			`<link rel="next" href="/fz/${id}/n.html">`,
			`<link rel="apple-touch-icon" href="/fz/${id}/0.png">`,
			`<link rel="expect" href="#x" blocking="render">`,
			`<svg><link rel="stylesheet" href="/fz/${id}/s.css"/></svg>`,
			`<link rel="stylesheet" href="/fz/${id}/s.css"><link rel="stylesheet" href="/fz/${id}/s.css">`,
		]);
		return {
			doc: shape,
			files: {
				[`/fz/${id}/s.css`]: {
					type: 'text/css',
					body: 'body{background-image:url(sub.png)}',
				},
				[`/fz/${id}/s.js`]: { type: 'text/javascript', body: '' },
				[`/fz/${id}/m.mjs`]: {
					type: 'text/javascript',
					body: `import './dep.mjs';`,
				},
			},
			tag: shape.slice(0, 100),
		};
	},
	// every element that fetches
	fetches: (s, id, r) => {
		const shape = r.pick([
			`<img src="/fz/${id}/0.png">`,
			`<video src="/fz/${id}/v.mp4"></video>`,
			`<video poster="/fz/${id}/0.png"></video>`,
			`<video><source src="/fz/${id}/v.mp4" type="video/mp4"></video>`,
			`<video src="/fz/${id}/v.mp4" preload="none"></video>`,
			`<audio src="/fz/${id}/a.mp3"></audio>`,
			`<audio><source src="/fz/${id}/a.mp3"></audio>`,
			`<video src="/fz/${id}/v.mp4"><track default kind="subtitles" src="/fz/${id}/t.vtt"></video>`,
			`<object data="/fz/${id}/0.png" type="image/png"></object>`,
			`<object data="/fz/${id}/o.html"></object>`,
			`<object data="/fz/${id}/o.svg" type="image/svg+xml"></object>`,
			`<object data="/fz/${id}/o.html"><img src="/fz/${id}/1.png"></object>`,
			`<embed src="/fz/${id}/0.png" type="image/png">`,
			`<embed src="/fz/${id}/o.svg">`,
			`<input type="image" src="/fz/${id}/0.png">`,
			`<input type="IMAGE" src="/fz/${id}/0.png">`,
			`<input type=" image" src="/fz/${id}/0.png">`,
			`<input src="/fz/${id}/0.png">`,
			`<iframe src="/fz/${id}/f.html"></iframe>`,
			`<iframe src="/fz/${id}/f.html" loading="lazy"></iframe>`,
			`<body background="/fz/${id}/0.png"></body>`,
			`<table background="/fz/${id}/0.png"><tr><td>x</td></tr></table>`,
			`<table><tr><td background="/fz/${id}/0.png">x</td></tr></table>`,
			`<table><tr><th background="/fz/${id}/0.png">x</th></tr></table>`,
			`<script src="/fz/${id}/s.js"></script>`,
			`<script src="/fz/${id}/s.js" async></script>`,
			`<script src="/fz/${id}/s.js" type="module"></script>`,
			`<script src="/fz/${id}/s.js" nomodule></script>`,
			`<script src=""></script>`,
			`<script src="/fz/${id}/s.js">${payload(s, id, 3)}</script>`,
			`<object data="/fz/${id}/x.xhtml"></object>`,
			`<iframe src="/fz/${id}/x.xhtml"></iframe>`,
			`<iframe src="/fz/${id}/o.svg"></iframe>`,
			`<img src="/fz/${id}/o.svg">`,
			`<embed src="/fz/${id}/x.xhtml" type="application/xhtml+xml">`,
			`<frameset><frame src="/fz/${id}/f.html"></frameset>`,
			`<keygen>`,
			`<a ping="/fz/${id}/ping" href="#x" id="a">x</a><script>document.getElementById('a').click()</script>`,
			`<form action="/fz/${id}/f.html"><input name="q" value="1"></form><script>document.forms[0].submit()</script>`,
			`<form action=""><button formaction="/fz/${id}/f.html" id="b">x</button></form><script>document.getElementById('b').click()</script>`,
			`<form action=" /fz/${id}/f.html " method="GET"></form><script>document.forms[0].submit()</script>`,
			`<form action="/fz/${id}/f.html" method="post"><input name="q" value="1"></form><script>document.forms[0].submit()</script>`,
			`<iframe name="t"></iframe><form action="/fz/${id}/f.html" target="t"></form><script>document.forms[0].submit()</script>`,
		]);
		return {
			doc: shape,
			files: {
				[`/fz/${id}/s.js`]: {
					type: 'text/javascript',
					body: payload(s, id, 1),
				},
				[`/fz/${id}/o.html`]: {
					type: 'text/html',
					body: `<img src="sub.png"><script>${payload(s, id, 2)}</script>`,
				},
				[`/fz/${id}/f.html`]: {
					type: 'text/html',
					body: `<img src="sub.png"><script>${payload(s, id, 4)}</script>`,
				},
				[`/fz/${id}/o.svg`]: {
					type: 'image/svg+xml',
					body: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="9" height="9"><image href="sub.png" width="1" height="1"/><image xlink:href="sub2.png" width="1" height="1"/><script>${payload(s, id, 5).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</script><style>@import url(sub.css);</style></svg>`,
				},
				[`/fz/${id}/x.xhtml`]: {
					type: 'application/xhtml+xml',
					body: `<html xmlns="http://www.w3.org/1999/xhtml"><head><script><![CDATA[${payload(s, id, 6)}]]></script></head><body><img src="sub.png"/><svg xmlns="http://www.w3.org/2000/svg"><image href="sub3.png" width="1" height="1"/></svg><noscript><img src="nos.png"/></noscript><style>body{background-image:url(bg.png)}</style></body></html>`,
				},
			},
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 100),
		};
	},
	// srcdoc, inside srcdoc
	srcdoc: (s, id, r) => {
		const img = `<img src="${s.origin}/fz/${id}/0.png">`;
		const p = `<script>${payload(s, id)}</script>`;
		const inner = r.next() < 0.5 ? img : p;
		const once = attr(inner);
		const twice = attr(`<iframe srcdoc="${attr(inner)}"></iframe>`);
		const shape = r.pick([
			`<iframe srcdoc="${once}"></iframe>`,
			`<iframe srcdoc="${twice}"></iframe>`,
			`<iframe srcdoc='${inner.replace(/'/g, '&#39;')}'></iframe>`,
			`<iframe srcdoc="${once}" src="${s.origin}/fz/${id}/f.html"></iframe>`,
			`<iframe srcdoc="&lt;img src=/fz/${id}/0.png&gt;"></iframe>`,
			`<iframe srcdoc="<img src=x.png>"></iframe>`,
			`<iframe srcdoc="<base href=/fz/${id}/b/><img src=x.png>"></iframe>`,
			`<iframe srcdoc="${attr(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">${inner}`)}"></iframe>`,
			`<iframe srcdoc="${attr(`<meta http-equiv="refresh" content="0;url=/fz/${id}/r.html">`)}"></iframe>`,
			`<iframe srcdoc="${attr(`<noscript>${img}</noscript>`)}"></iframe>`,
			`<iframe srcdoc="${once}" sandbox></iframe>`,
			`<iframe srcdoc="${once}" sandbox="allow-scripts"></iframe>`,
			`<iframe srcdoc="${attr(`<noscript>${img}</noscript>`)}" sandbox="allow-same-origin"></iframe>`,
			`<iframe srcdoc=""></iframe>`,
			`<iframe SRCDOC="${once}"></iframe>`,
		]);
		return {
			doc: shape,
			tag: shape.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 100),
		};
	},
	// what the doctype makes of the document
	doctype: (s, id, r) => {
		const doctype = r.pick([
			'',
			'<!DOCTYPE html>',
			'<!doctype HTML>',
			'<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
			'<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
			'<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">',
			'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
			'<!DOCTYPE html SYSTEM "about:legacy-compat">',
			'<!DOCTYPE html SYSTEM "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd">',
			'<!DOCTYPE foo>',
			'<!DOCTYPE>',
			'<!DOCTYPE html PUBLIC "-//W3O//DTD W3 HTML Strict 3.0//EN//">',
			'<!DOCTYPE html PUBLIC "-//IETF//DTD HTML//EN">',
			'<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">',
			'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Frameset//EN" "x">',
			'<!-- c --><!DOCTYPE html>',
			' <!DOCTYPE html>',
			'<!DOCTYPE html"><img src="/fz/ID/0.png">',
		]);
		return {
			doc: `${doctype.replace('ID', id)}<p>x</p>`,
			own: true,
			tag: doctype,
		};
	},
	// a URL attribute whose value is no URL: natively the load fails and the
	// page goes on
	'invalid-url': (s, id, r) => {
		const bad = r.pick([
			`http://127.0.0.1:PORTX/fz/${id}/0.png`,
			'http://[::1/x.png',
			'http://a b/x.png',
			'https://',
			'http://%zz/x.png',
			'http:// /',
			'//:0/x',
		]);
		const el = r.pick([
			(v) => `<img src="${attr(v)}">`,
			(v) => `<img srcset="${attr(v)} 1x">`,
			(v) => `<script src="${attr(v)}"></script>`,
			(v) => `<link rel="stylesheet" href="${attr(v)}">`,
			(v) => `<iframe src="${attr(v)}"></iframe>`,
			(v) => `<a href="${attr(v)}">x</a>`,
			(v) => `<form action="${attr(v)}"></form>`,
			(v) => `<video poster="${attr(v)}"></video>`,
			(v) => `<object data="${attr(v)}"></object>`,
			(v) => `<svg><image href="${attr(v)}"/></svg>`,
			(v) => `<base href="${attr(v)}">`,
			(v) => `<meta http-equiv="refresh" content="0;url=${attr(v)}">`,
			(v) => `<div style="background-image:url('${attr(v)}')"></div>`,
		]);
		const doc = `${el(bad)}<script>${payload(s, id)}</script>`;
		return { doc, tag: doc.slice(0, 90) };
	},
	// the presentational background attribute, and the elements that take it
	'background-attr': (s, id, r) => {
		const v = r.pick([
			`${s.origin}/fz/${id}/0.png`,
			`/fz/${id}/0.png`,
			`${s.other}/fz/${id}/0.png`,
		]);
		const doc = r.pick([
			`<body background="${v}"></body>`,
			`<table background="${v}"><tr><td>x</td></tr></table>`,
			`<table><thead background="${v}"><tr><td>x</td></tr></thead></table>`,
			`<table><tbody background="${v}"><tr><td>x</td></tr></tbody></table>`,
			`<table><tfoot background="${v}"><tr><td>x</td></tr></tfoot></table>`,
			`<table><tr background="${v}"><td>x</td></tr></table>`,
			`<table><tr><td background="${v}">x</td></tr></table>`,
			`<table><tr><th background="${v}">x</th></tr></table>`,
			`<div background="${v}">x</div>`,
			`<frameset background="${v}"><frame></frameset>`,
		]);
		return { doc, tag: doc.slice(0, 90) };
	},
	// a <style> the client writes back through a script of its own: its
	// text must stay text however it is written
	'style-text': (s, id, r) => {
		const p = `new Image().src=\`${s.origin}/fz/${id}/ran-0.png?l=\`+encodeURIComponent(location.href)+\`&t=\`+encodeURIComponent(top.location.href)`;
		const doc = r.pick([
			`<style></script><script>${p}</script></style>`,
			`<style></SCRIPT><script>${p}</script></style>`,
			`<style><!--</script><script>${p}</script>--></style>`,
			`<style>/*</script><script>${p}</script>*/</style>`,
			`<style>a{content:"</script><script>${p}</script>"}</style>`,
			`<style>\u2028</script><script>${p}</script></style>`,
			`<div><style></script><img src="${s.origin}/fz/${id}/0.png"></style></div>`,
		]);
		return { doc, tag: doc.slice(0, 90) };
	},
	// a document whose Content-Type says nothing the browser can use
	// (none, empty, unknown/unknown, application/unknown, */*, no slash),
	// which Chrome reads as HTML when its first bytes start one of the tags
	// of its sniff table (net/base/mime_sniffer.cc SniffForHTML), unless
	// the answer says nosniff; text/plain never sniffs to HTML. The proxy
	// must make the same call: a body it passes through as not a document
	// that the browser then sniffs as one runs its scripts unrewritten.
	// (<?xml, which sniffs to an XML document, is the misc-escapes stream's.)
	'mime-sniff': (s, id, r) => {
		const [type, headers, body] = r.pick(MIME_SNIFF_CASES);
		const doc = body(payload(s, id));
		return {
			doc,
			own: true,
			served: { type, headers },
			tag: `${type === null ? 'none' : JSON.stringify(type)}${headers ? ' nosniff' : ''} ${JSON.stringify(doc.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 60))}`,
		};
	},
	// noscript, which the inject reads with scripting off and the document
	// with scripting on
	noscript: (s, id, r) => {
		const img = `<img src="${s.origin}/fz/${id}/0.png">`;
		const p = `<script>${payload(s, id)}</script>`;
		const inner = r.next() < 0.5 ? img : p;
		const doc = r.pick([
			`<noscript><style></noscript>${inner}</style></noscript>`,
			`<noscript><title></noscript>${inner}</title></noscript>`,
			`<noscript><textarea></noscript>${inner}</textarea></noscript>`,
			`<noscript><xmp></noscript>${inner}</xmp></noscript>`,
			`<noscript><iframe></noscript>${inner}</iframe></noscript>`,
			`<noscript><noembed></noscript>${inner}</noembed></noscript>`,
			`<noscript><script></noscript>${inner}</script></noscript>`,
			`<noscript><!--</noscript>${inner}--></noscript>`,
			`<noscript><a title="</noscript>${inner}"></a></noscript>`,
			`<noscript><style></NOSCRIPT >${inner}</style></noscript>`,
			`<noscript><style></noscript/>${inner}</style></noscript>`,
			`<head><noscript><style></noscript>${inner}</style></noscript></head>`,
			`<noscript><noscript></noscript>${inner}</noscript>`,
			`<noscript><svg><style></noscript>${inner}</style></svg></noscript>`,
		]);
		return {
			doc,
			tag: doc.replace(/\(function.*?\}\)\(\)/g, 'P').slice(0, 90),
		};
	},
};

/** the case document: `own` doctypes come as they are, the rest are standards mode */
function caseDocument(made) {
	return made.own
		? made.doc
		: `<!DOCTYPE html><meta charset="utf-8">${made.doc}`;
}

const COLLECT = `<script>
window.__fzCollect = () => {
	const out = {};
	// the element tree and attribute names, the signal that markup was built
	// the same way; the text of a script, style, title or textarea is left
	// out because the inject rewrites a script's text and adds a
	// currentScript preamble on purpose (whether a script RAN unrewritten is
	// the ran-N request, not its text here), and a title changes with a
	// navigation a javascript: URL made
	const RAW = /^(script|style|title|textarea|noscript)$/;
	const shape = (root, depth = 0) => {
		const parts = [];
		const walk = (node, inRaw) => {
			if (parts.length > 80) return;
			for (let child = node.firstChild; child; child = child.nextSibling) {
				if (child.nodeType === 1) {
					const names = child.getAttributeNames().filter((n) => !/^on/i.test(n)).sort();
					parts.push(child.localName + (names.length ? '[' + names.join(',') + ']' : ''));
					const raw = inRaw || RAW.test(child.localName);
					if (child.localName === 'template' && child.content) { parts.push('#content('); walk(child.content, raw); parts.push(')'); }
					if (child.shadowRoot) { parts.push('#shadow('); walk(child.shadowRoot, raw); parts.push(')'); }
					walk(child, raw);
				} else if (child.nodeType === 3 && !inRaw) {
					const text = child.data.trim();
					if (text) parts.push('"' + text.slice(0, 40) + '"');
				} else if (child.nodeType === 8) parts.push('<!--' + child.data.slice(0, 20) + '-->');
			}
		};
		walk(root, false);
		return parts.join(' ');
	};
	for (const frame of document.querySelectorAll('iframe[data-case]')) {
		const id = frame.dataset.case;
		try {
			const doc = frame.contentDocument;
			if (!doc) { out[id] = { doc: null }; continue; }
			out[id] = { mode: doc.compatMode, shape: shape(doc.documentElement ? doc : doc) };
		} catch (e) {
			out[id] = { threw: e.name };
		}
	}
	return out;
};
</script>`;

function batchPage(s, made) {
	return `<!doctype html><html><head><meta charset="utf-8">${headScript}</head><body>
${made.map((m) => `<iframe data-case="${m.id}" src="/fz/${m.id}/doc.html" width="60" height="40"></iframe>`).join('\n')}
${COLLECT}
${doneScript(s.origin, 1500)}
</body></html>`;
}

const ONLY = process.env.FZ_ONLY ? new RegExp(process.env.FZ_ONLY) : null;

function build(s) {
	// every shape of every family: a family's picks are enumerated (each
	// pick of a run is a digit of a mixed-radix counter), up to a cap
	const made = [];
	const seen = new Set();
	let n = 0;
	const cap = Math.round(260 * SCALE);
	for (const [family, make] of Object.entries(families)) {
		const digits = [];
		const radix = [];
		let done = false;
		let count = 0;
		while (!done && count < cap) {
			let at = 0;
			const r = {
				pick: (list) => {
					if (radix.length <= at) {
						radix.push(list.length);
						digits.push(0);
					}
					return list[digits[at++] % list.length];
				},
				next: () => r.pick([0.25, 0.75]),
			};
			const id = `h${n}`;
			const m = make(s, id, r);
			// the next combination
			let k = digits.length - 1;
			while (k >= 0) {
				digits[k]++;
				if (digits[k] < radix[k]) break;
				digits[k] = 0;
				k--;
			}
			if (k < 0) done = true;
			count++;
			const key = `${family}|${m.tag}|${m.doc.replaceAll(id, 'ID')}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (ONLY && !ONLY.test(`${family} ${m.tag}`)) continue;
			n++;
			made.push({ ...m, id, family });
		}
	}
	// a seeded order, so a short budget still meets every family
	const order = prng(SEED);
	for (let i = made.length - 1; i > 0; i--) {
		const j = order.int(i + 1);
		[made[i], made[j]] = [made[j], made[i]];
	}
	const batches = [];
	for (let i = 0; i < made.length; i += PER_BATCH) {
		const slice = made.slice(i, i + PER_BATCH);
		const files = {};
		for (const m of slice) {
			Object.assign(files, m.files ?? {});
			files[`/fz/${m.id}/doc.html`] = {
				type: m.served ? m.served.type : 'text/html; charset=utf-8',
				headers: m.served?.headers,
				body: caseDocument(m),
			};
		}
		batches.push({
			id: `html${batches.length}`,
			page: batchPage(s, slice),
			files,
			cases: slice.map((m) => ({
				id: m.id,
				tags: { family: m.family, tag: m.tag },
				repro: `${m.family}: ${caseDocument(m).replaceAll(s.origin, 'ORIGIN')}`,
			})),
		});
	}
	return batches;
}

// The findings of this group that are open on purpose, each with its reason
// and the cases it covers (test/parserFuzz.mjs, `knownOpen`).
const KNOWN_OPEN = {
	// escapes first
	'noscript-scripting-off': {
		// STomp parses the document with scripting off (its noscript holds
		// elements) and writes the noscript's content back as markup; Chrome
		// parses it with scripting on, where noscript is raw text. A
		// `<noscript><style></noscript><img src=...>` (or a comment, a title
		// attribute holding `</noscript>`) breaks out in Chrome's parse: what
		// follows loads or runs unrewritten (an escape), and what native
		// keeps as noscript text the proxy loads (a breakage)
		why: 'noscript content is parsed with scripting off and written back raw (src/inject/dom/sandbox.ts textifyNoscript, serializeScripted)',
		match: (c, f) =>
			/<noscript/i.test(c.repro) &&
			['noscript', 'raw-text', 'srcdoc'].includes(c.tags.family) &&
			(f.kind === 'escape' || f.kind === 'breakage'),
	},
	'svg-document-copy': {
		// <object data> and <embed src> naming an SVG document: the inject
		// fetches it through the proxy and hands the element a blob: copy of
		// it as it came, so the SVG's own <script> runs unrewritten in the
		// blob (its loads go out direct) and its @import/<image> loads
		// differ; an XHTML or nested HTML object loads less than native
		why: 'an object/embed SVG document is copied into a blob: unrewritten (src/inject/dom/modules/DOMAttributes.ts proxiedLoad)',
		match: (c, f) =>
			c.tags.family === 'fetches' &&
			/<(object|embed)\b/.test(c.repro) &&
			(f.kind === 'escape' || f.kind === 'breakage'),
	},
	// breakages
	'leading-comment': {
		// a comment before the root element is a child of the document
		// natively; the proxied document has none there (a text/html one
		// too: measured with the mime-sniff family's text/html control)
		why: "a comment before the document's root element is not kept as the document's child (the shell's document, src/inject/dom/Client.ts loadHTML)",
		match: (c, f) =>
			f.kind === 'breakage' &&
			f.what === 'observed shape' &&
			/^native <!--/.test(f.detail) &&
			!/^native <!--[^>]*--> proxied <!--/.test(f.detail),
	},
	'srcset-grammar': {
		// the srcset npm parser (src/inject/dom/modules/DOMAttributes.ts)
		// splits on Unicode whitespace (a no-break space ends the URL, which
		// natively is part of it), accepts an upper-case `X` and an unknown
		// descriptor (Chrome drops the candidate), and reads data: URLs with
		// commas differently: the candidate chosen differs
		why: 'srcset is parsed by the srcset package, not the HTML grammar (src/inject/dom/modules/DOMAttributes.ts srcset hook)',
		match: (c, f) => c.tags.family === 'srcset' && f.kind === 'breakage',
	},
	'base-after-url': {
		// a URL attribute parsed before a later <base href> (or a base inside
		// <svg>, or base about:blank): Chrome fetched it against the
		// document's URL while parsing; the inject's loadHTML runs the hooks
		// on the whole document, with the base already there
		why: 'loadHTML routes every attribute against the final base, not the base at parse time (src/inject/dom/Client.ts baseURL, loadHTML)',
		match: (c, f) =>
			(c.tags.family === 'base' ||
				(c.tags.family === 'srcdoc' && /<base /.test(c.repro))) &&
			f.kind === 'breakage',
	},
	'invalid-base': {
		// an unparseable <base href> (http://%zz, https://, //:0): Chrome
		// falls back to the document's URL; proxied, the script after it
		// does not make its loads
		why: 'a <base href> the URL parser rejects leaves the proxied base unusable (src/inject/dom/modules/DOMAttributes.ts BASE href hook, src/inject/dom/Client.ts baseURL)',
		match: (c, f) =>
			c.tags.family === 'invalid-url' &&
			/<base /.test(c.repro) &&
			f.kind === 'breakage',
	},
	'quirks-doctype': {
		// a legacy PUBLIC or SYSTEM identifier that puts Chrome in quirks
		// mode, or a comment before the doctype: the shell's own doctype
		// leads the proxied document, which renders in standards mode
		why: "the shell writes its own doctype first (src/rewriteHTML.ts), so the page's doctype does not set the mode",
		match: (c, f) => c.tags.family === 'doctype' && f.kind === 'breakage',
	},
	'data-refresh-readback': {
		// a meta refresh to a data: document (now rewritten, so no escape):
		// the document's location reads the rewritten data: URL, not the
		// one the page wrote
		why: 'a rewritten data: document reads its rewritten URL as location (src/rewriteHTML.ts routeHTML data:)',
		match: (c, f) =>
			c.tags.family === 'meta-refresh' &&
			/url=data:/i.test(c.repro) &&
			f.kind === 'breakage',
	},
	'foreign-content': {
		// SVG CDATA holding `</svg>`, a <style> under MathML mglyph in a
		// table, an SVG <link rel=stylesheet>, a nested declarative shadow
		// root: the tree STomp builds for routing differs from Chrome's, so
		// a load native makes is not made proxied
		why: "the inject's parse of foreign content and nested shadow roots differs from Chrome's tree builder (src/inject/dom/Client.ts loadHTML)",
		match: (c, f) =>
			['foreign', 'link', 'shadow-select'].includes(c.tags.family) &&
			f.kind === 'breakage',
	},
};

await runDifferential({
	name: 'parse-html',
	build,
	knownOpen: KNOWN_OPEN,
	budget: Number(process.env.FZ_BUDGET || 420000),
	native: process.env.FZ_NATIVE === '1',
});
