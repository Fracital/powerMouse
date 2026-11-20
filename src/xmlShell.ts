// The XML shell (modifyXML), apart from src/rewriteHTML.ts: the worker
// serves it for every XML document, and in a page it is a deferred part
// (src/inject/dom/deferredParts.ts), since a document bundle meets an XML
// document of its own making (a data: URL, an object's copy) so rarely. It
// writes the HTML shell's statements (src/htmlShell.ts), and is evaluated
// with it.
import type { Config } from './config';
import type { PolicyText, ScriptFacts } from './csp';
import { helperNames } from './helperNames';
import {
	keptFacts,
	leftKept,
	libraryScripts,
	marked,
	policyTexts,
	referred,
	scriptFacts,
	sited,
	syncXHR,
} from './htmlShell';
import type { ReferrerInfo } from './referrerPolicy';
import { providedShell } from './rewriteHTML';
import { BUNDLE_CLIENT, injectDocumentJS } from './routeURL';
import type { SiteFacts } from './siteFacts';
import type StompURL from './StompURL';
import { WORKER_BASE } from './transport/messages';

const UNICODE = ['utf-8', 'utf-16le', 'utf-16be'];

/** the document's root start tag (name, attributes), after the prolog, comments and doctype */
function rootTag(script: string): RegExpExecArray | null {
	const tags =
		/<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<([A-Za-z_][\w.:-]*)(\s[^>]*?)?(\/?)>/g;
	let match: RegExpExecArray | null;
	while ((match = tags.exec(script)) !== null) if (match[1]) return match;
	return null;
}

/**
 * The encoding the worker serves an XML document's shell in: the
 * document's own, which its characterSet reads as natively. A legacy
 * encoding's shell is ASCII, so a root whose start tag has what is not
 * ASCII outside its attribute values (a name) is served as UTF-8.
 */
export function xmlShellEncoding(script: string, encoding: string): string {
	if (UNICODE.includes(encoding)) return encoding;
	const tag = rootTag(script)?.[0] ?? '';
	return /[^\0-\x7f]/.test(tag.replace(/"[^"]*"|'[^']*'/g, ''))
		? 'utf-8'
		: encoding;
}

/**
 * The shell of an XML document (a standalone SVG, an XHTML page): the same
 * root element with its namespace declarations, holding the inject bundle
 * and the client call as XHTML script elements (which an XML parser runs),
 * the original markup in a CDATA section. The client parses it with the
 * document's own mime and replaces the root in place: an XML document has
 * no document.write.
 */
export function modifyXML(
	script: string,
	url: StompURL,
	config: Config,
	mime: string,
	referrer?: ReferrerInfo,
	sites?: SiteFacts[],
	/** as modifyHTML's */
	top = false,
	/** as modifyHTML's */
	policies?: PolicyText[],
	/** as modifyHTML's */
	facts?: ScriptFacts,
	/** as modifyHTML's */
	syncXHRBlocked?: boolean,
	/** the shell names `url` as the document's (an embed's or object's copy, at a blob: address), as modifyHTML's `base` */
	base = false,
	/** what the worker encodes the shell in (encodeShell), which its declaration names */
	encoding = 'utf-8',
): string {
	const provided = providedShell();
	facts ??= provided.facts;
	syncXHRBlocked ??= provided.syncXHRBlocked;
	const match = rootTag(script);
	const name = match?.[1] ?? 'svg';
	let root = match
		? `<${name}${match[2] ?? ''}>`
		: `<svg xmlns="http://www.w3.org/2000/svg">`;
	if (mime === 'application/xhtml+xml' && !match)
		root = `<html xmlns="http://www.w3.org/1999/xhtml">`;
	// a legacy encoding's shell is ASCII (encodeShell): what is not ASCII in
	// the root's attribute values is a character reference, the same value
	if (!UNICODE.includes(encoding))
		root = root.replace(/"[^"]*"|'[^']*'/g, (value) =>
			value.replace(
				/[^\0-\x7f]/gu,
				(char) => `&#x${char.codePointAt(0)!.toString(16)};`,
			),
		);
	const cdata = (text: string) =>
		`<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
	const names = helperNames(config);
	const inject = `if (!(${JSON.stringify(names.client)} in globalThis) && typeof globalThis.createClient !== 'function') {
	document.documentElement.textContent = "Stomp bundle did not load. See devtools output for more information.";
${leftKept(names.client, url)}} else {
	${scriptFacts(facts)}if (!(${JSON.stringify(names.client)} in globalThis))
		createClient(${JSON.stringify(config)}, ${JSON.stringify(url.codec.key)});
	else {
		delete globalThis.createClient;
		${names.client}.takeNamedBase();
	}${keptFacts(names.client, facts)}${marked(names.client, url)}
${sited(names.client, sites)}${referred(names.client, referrer)}${policyTexts(names.client, policies)}${syncXHR(names.client, syncXHRBlocked)}
	if (!${names.client}.applied) ${names.client}.apply();
	${names.client}.loadXML(${JSON.stringify(script)}, ${JSON.stringify(mime)});
}`;
	const xhtml = 'http://www.w3.org/1999/xhtml';
	const own = ` xmlns="${xhtml}"${facts?.nonce ? ` nonce="${facts.nonce.replace(/[^\w+/=-]/g, '')}"` : ''}`;
	const loading = facts?.loadsByNonce ? own : ` xmlns="${xhtml}"`;
	const named = base
		? `<script${own}>${cdata(`globalThis[${JSON.stringify(WORKER_BASE)}] = ${JSON.stringify(url.toString())};`)}</script>`
		: '';
	return `<?xml version="1.0" encoding="${encoding}"?>${root}${named}${top ? libraryScripts(url, config, own, loading) : ''}<script${loading} src="${injectDocumentJS(url, config)}" ${BUNDLE_CLIENT}="${names.client}"></script><script${own}>${cdata(inject)}</script></${name}>`;
}
