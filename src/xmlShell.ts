// The XML shell (modifyXML), apart from src/rewriteHTML.ts: the worker
// serves it for every XML document, and in a page it is a deferred part
// (src/inject/dom/deferredParts.ts), since a document bundle meets an XML
// document of its own making (a data: URL, an object's copy) so rarely.
import type { Config } from './config';
import type { PolicyText, ScriptFacts } from './csp';
import { helperNames } from './helperNames';
import type { ReferrerInfo } from './referrerPolicy';
import {
	keptFacts,
	libraryScripts,
	marked,
	policyTexts,
	providedShell,
	referred,
	scriptFacts,
	sited,
	syncXHR,
} from './rewriteHTML';
import { injectDocumentJS } from './routeURL';
import type { SiteFacts } from './siteFacts';
import type StompURL from './StompURL';
import { WORKER_BASE } from './transport/messages';

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
): string {
	const provided = providedShell();
	facts ??= provided.facts;
	syncXHRBlocked ??= provided.syncXHRBlocked;
	// the root start tag, after the prolog, comments and doctype
	const tags =
		/<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<([A-Za-z_][\w.:-]*)(\s[^>]*?)?(\/?)>/g;
	let root = `<svg xmlns="http://www.w3.org/2000/svg">`;
	let name = 'svg';
	let match: RegExpExecArray | null;
	while ((match = tags.exec(script)) !== null) {
		if (match[1]) {
			name = match[1];
			root = `<${name}${match[2] ?? ''}>`;
			break;
		}
	}
	if (mime === 'application/xhtml+xml' && !match?.[1])
		root = `<html xmlns="http://www.w3.org/1999/xhtml">`;
	const cdata = (text: string) =>
		`<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
	const names = helperNames(config);
	const inject = `if (typeof globalThis.createClient !== 'function') {
	document.documentElement.textContent = "Stomp bundle did not load. See devtools output for more information.";
} else {
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
	return `<?xml version="1.0" encoding="UTF-8"?>${root}${named}${top ? libraryScripts(url, config, own, loading) : ''}<script${loading} src="${injectDocumentJS(url, config)}"></script><script${own}>${cdata(inject)}</script></${name}>`;
}
