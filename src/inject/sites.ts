// What this bundle was told of sites, and so does not ask the public suffix
// list: the service worker writes a document's own host's answers, and its
// top's, into the shell (src/siteFacts.ts), and the client hands them here
// before the page runs. A document asks about its own host again and again
// (its site key for the window membrane, its cookie key, its storage
// partition, a cookie's Domain attribute, a `document.domain` write), and
// before this each of those was a call into the rewriter library and its
// copy of the list (a top's, or one a document that shares none evaluated
// for it). Answered here, they need no list in the page at all, which is
// what lets tldts leave the bundle (docs/rust-plan.md, phase 2).
//
// A shell this bundle writes itself (an srcdoc, a blob: document) carries
// what the bundle knows on to the document it makes, whose URL is this
// document's or one of this site.
import { provideShellSites } from '../rewriteHTML';
import { readSiteFacts, type SiteAnswers, type SiteFacts } from '../siteFacts';

/**
 * The answers by name, as the service worker's list gave them, and the
 * facts as they came, by host, for the shells this bundle writes. Objects
 * without a prototype, read by key: the window membrane decides by these
 * answers whether another window is this site's, and a lookup that went
 * through a method of a prototype would be one the page could answer.
 */
const known: Record<string, SiteAnswers | undefined> = Object.create(null);
const told: Record<string, SiteFacts | undefined> = Object.create(null);
let hosts = 0;
/** a bundle is told of its own host and its top's; one that lives through many documents starts over */
const MAX_HOSTS = 16;

/**
 * How many site questions this bundle answered from what it was told, and
 * how many it had to ask the list (tests, and the measure of what is left
 * for the list: docs/rust-plan.md)
 */
export const siteAnswers = { known: 0, asked: 0 };

/** keep what a shell says of one host; false when it is not facts */
export function learnSites(facts: unknown): boolean {
	const read = readSiteFacts(facts);
	if (!read) return false;
	const host = (facts as SiteFacts)[0];
	if (told[host] === undefined) {
		if (hosts >= MAX_HOSTS) {
			for (const name in known) delete known[name];
			for (const name in told) delete told[name];
			hosts = 0;
		}
		hosts++;
	}
	told[host] = facts as SiteFacts;
	for (const [name, answers] of read) known[name] = answers;
	return true;
}

/**
 * What this bundle knows of `host`'s site without the list: answer 0 the
 * registrable domain, 1 the public suffix, both with the list's private
 * section; undefined when it was not told. The empty host has neither
 * (tldts answers null).
 */
export function knownSite(
	host: unknown,
	answer: 0 | 1,
): string | null | undefined {
	if (typeof host !== 'string') return undefined;
	if (host === '') {
		siteAnswers.known++;
		return null;
	}
	const answers = known[host];
	if (answers === undefined) {
		siteAnswers.asked++;
		return undefined;
	}
	siteAnswers.known++;
	return answers[answer];
}

provideShellSites(() => {
	const all: SiteFacts[] = [];
	for (const host in told) all.push(told[host]!);
	return all;
});
