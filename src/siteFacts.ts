// What a document is told of its own host's site, so that it need not hold
// the public suffix list to know it. The service worker asks the list
// (src/suffix.ts) when it serves a document and writes the answers into
// the shell: for the document's host and each name above it (for
// www.example.co.uk: example.co.uk, co.uk, uk), the registrable domain and
// the public suffix as the inject asks for them. The inject keeps them by
// name (src/inject/sites.ts) and asks the list itself only about a name
// it was not told of.
//
// The answers are the list's own for exactly these names, not worked out
// from one another: under the list's wildcard and exception rules a name's
// suffix does not follow from the suffix of the name below it (city.kobe.jp
// is registrable under kobe.jp, whose own suffix is jp).

/**
 * One host's answers, as the shell carries them: the host, then for the
 * host and each name above it two spans of the host (start and end; -1
 * and -1 for null): `getDomain` and `getPublicSuffix`, both with the
 * list's private section, which is where Chrome ends a site (two
 * customers of github.io are two sites)
 */
export type SiteFacts = [host: string, ...spans: number[]];

/** the two answers for a name, in the order the spans are written */
export type SiteAnswers = [domain: string | null, publicSuffix: string | null];

/** numbers per name: a start and an end for each answer */
const SPANS = 4;

/** what answers a host's site: src/suffix.ts in the service worker */
export interface SiteLookups {
	getDomain(host: string, privateDomains?: boolean): string | null;
	getPublicSuffix(host: string, privateDomains?: boolean): string | null;
}

/** more names than any real host has; a longer one keeps its shortest */
const MAX_NAMES = 12;

/** where `host` and each name above it start in `host` */
function nameStarts(host: string): number[] {
	const starts = [0];
	for (
		let dot = host.indexOf('.');
		dot >= 0 && dot + 1 < host.length;
		dot = host.indexOf('.', dot + 1)
	)
		starts.push(dot + 1);
	return starts.length > MAX_NAMES
		? [0, ...starts.slice(1 - MAX_NAMES)]
		: starts;
}

/**
 * The facts of `host` as `lookups` answers them, or null when there is
 * nothing to say (no host) or an answer is not a piece of the host
 */
export function siteFacts(
	host: string,
	lookups: SiteLookups,
): SiteFacts | null {
	if (host === '') return null;
	const facts: SiteFacts = [host];
	for (const start of nameStarts(host)) {
		const name = host.slice(start);
		const answers: SiteAnswers = [
			lookups.getDomain(name, true),
			lookups.getPublicSuffix(name, true),
		];
		for (const answer of answers) {
			if (answer === null) {
				facts.push(-1, -1);
				continue;
			}
			const at = name.lastIndexOf(answer);
			if (at < 0) return null;
			facts.push(start + at, start + at + answer.length);
		}
	}
	return facts;
}

/**
 * The answers `facts` holds, by name; null for anything that is not facts
 * as siteFacts writes them (the shell's text is the service worker's, but
 * a table read wrongly would answer a site wrongly)
 */
export function readSiteFacts(
	facts: unknown,
): [name: string, answers: SiteAnswers][] | null {
	if (!Array.isArray(facts) || typeof facts[0] !== 'string' || facts[0] === '')
		return null;
	const host: string = facts[0];
	const starts = nameStarts(host);
	if (facts.length !== 1 + starts.length * SPANS) return null;
	const read: [string, SiteAnswers][] = [];
	let at = 1;
	for (const start of starts) {
		const answers: (string | null)[] = [];
		for (let answer = 0; answer < SPANS / 2; answer++) {
			const from: unknown = facts[at++];
			const to: unknown = facts[at++];
			if (from === -1 && to === -1) {
				answers.push(null);
				continue;
			}
			if (
				!Number.isInteger(from) ||
				!Number.isInteger(to) ||
				(from as number) < start ||
				(to as number) <= (from as number) ||
				(to as number) > host.length
			)
				return null;
			answers.push(host.slice(from as number, to as number));
		}
		read.push([host.slice(start), answers as SiteAnswers]);
	}
	return read;
}
