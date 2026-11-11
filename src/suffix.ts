// "What is this host's site": tldts's getDomain and getPublicSuffix, asked
// of the suffix module when this thread holds it (`rewriter: 'wasm'`,
// src/wasm/suffix.ts) and of tldts otherwise. The two give the same answer
// for every input (rust/host/suffix.mjs compares them), so which one
// answered never shows. This is the one place a bundle takes tldts in from:
// when the module serves every thread, what is left to remove is here
// (docs/rust-plan.md, phase 2).
import {
	getDomain as tldtsDomain,
	getPublicSuffix as tldtsPublicSuffix,
} from 'tldts';
import { domainOf, publicSuffixOf } from './wasm/suffix';

/**
 * The registrable domain of `host` (a host or a URL), or null for an IP, a
 * public suffix or a name with none: tldts `getDomain`, with the list's
 * private section (github.io is a suffix) when `privateDomains`, the ICANN
 * section alone by default as tldts has it
 */
export function getDomain(host: string, privateDomains = false): string | null {
	const answered = domainOf(host, privateDomains);
	if (answered !== undefined) return answered;
	return tldtsDomain(host, { allowPrivateDomains: privateDomains });
}

/**
 * The public suffix of `host`, or null for an IP: tldts `getPublicSuffix`,
 * with the private section when `privateDomains`
 */
export function getPublicSuffix(
	host: string,
	privateDomains = false,
): string | null {
	const answered = publicSuffixOf(host, privateDomains);
	if (answered !== undefined) return answered;
	return tldtsPublicSuffix(host, { allowPrivateDomains: privateDomains });
}
