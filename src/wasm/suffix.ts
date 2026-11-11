// The suffix module (rust/suffix, `suffix.wasm`) as a thread calls it: what
// tldts's getDomain and getPublicSuffix answer for a string, from a table
// of the public suffix list in the module instead of tldts's own in the
// bundle. The answers are tldts's for every input, a URL or a host or
// neither (rust/host/suffix.mjs holds the two together), so a caller may
// ask either and never tell. Both functions answer undefined when this
// thread holds no module or the module gave no answer, and the caller then
// asks tldts (src/suffix.ts).
import type { BufferInstance } from './module';
import { withInstance } from './thread';

/** the suffix module's Assets key (src/config.ts) */
export const SUFFIX = 'suffix';

// the flags of the module's call (rust/suffix/src/lib.rs)
const PUBLIC_SUFFIX = 1;
const PRIVATE = 2;
const HOST = 4;
const VALID = 8;
const PIN = 16;

/** what tldts drops from an input before it parses it again */
const CONTROLS = /[\t\n\r]/g;

/**
 * The answers the instance in `memoOf` gave lately, by flags and then by
 * input: a browsing session asks about the same few hosts with every
 * request, and a call into the module costs several tldts lookups. A new
 * instance (another module adopted, a trap) starts it over, and so does
 * filling it.
 */
const memo: Map<string, string | null>[] = [
	new Map(),
	new Map(),
	new Map(),
	new Map(),
];
let memoOf: BufferInstance | null = null;
let memoSize = 0;
const MEMO_ENTRIES = 2048;
/** a host name is at most 255 long; longer inputs are not worth keeping */
const MEMO_INPUT = 255;

function forget(): void {
	for (const kept of memo) kept.clear();
	memoSize = 0;
}

/**
 * The module's answer for `input`: a string or null as tldts answers, in an
 * array so that it is told from no answer at all. The module says where the
 * answer stands in the input and the slice is taken here, so nothing is
 * decoded back; it also leaves to this side the two things tldts does with
 * the string itself (ECMAScript's lower case, and dropping tabs and
 * newlines), each of which is one more call.
 */
function ask(input: string, flags: number): [string | null] | null {
	return withInstance(SUFFIX, (instance): [string | null] | null => {
		if (instance !== memoOf) {
			forget();
			memoOf = instance;
		}
		const known = memo[flags].get(input);
		if (known !== undefined) return [known];
		const keep = (answer: string | null): [string | null] => {
			if (input.length <= MEMO_INPUT) {
				if (memoSize >= MEMO_ENTRIES) forget();
				memo[flags].set(input, answer);
				memoSize++;
			}
			return [answer];
		};
		let text = input;
		let asked = flags;
		// at most: the controls dropped, the host lower-cased, the answer
		for (let round = 0; round < 3; round++) {
			const result = instance.call(text, asked);
			if (!('output' in result)) return null;
			if (result.output === '') return keep(null);
			const [start, end, then] = result.output.split(' ').map(Number);
			// an answer this code does not read is no answer
			if (
				!Number.isInteger(start) ||
				!Number.isInteger(end) ||
				start < 0 ||
				end < start ||
				end > text.length
			)
				return null;
			if (then === undefined) return keep(text.slice(start, end));
			if (then === 1) return keep(text.slice(start, end).toLowerCase());
			if (then === 2 || then === 3) {
				text = text.slice(start, end).toLowerCase();
				asked = flags | HOST | (then === 3 ? VALID : 0);
			} else if (then === 4) text = text.replace(CONTROLS, '');
			else return null;
		}
		return null;
	});
}

/**
 * tldts `getDomain(input, { allowPrivateDomains })`: the registrable
 * domain, or null; undefined when the module does not answer
 */
export function domainOf(
	input: string,
	privateDomains: boolean,
): string | null | undefined {
	if (typeof input !== 'string') return undefined;
	const answer = ask(input, privateDomains ? PRIVATE : 0);
	return answer ? answer[0] : undefined;
}

/**
 * tldts `getPublicSuffix(input, { allowPrivateDomains })`: the public
 * suffix, or null; undefined when the module does not answer
 */
export function publicSuffixOf(
	input: string,
	privateDomains: boolean,
): string | null | undefined {
	if (typeof input !== 'string') return undefined;
	const answer = ask(input, PUBLIC_SUFFIX | (privateDomains ? PRIVATE : 0));
	return answer ? answer[0] : undefined;
}

/**
 * The public suffix list this thread's module was built from: its commit
 * in the publicsuffix/list repository and that commit's date
 * (rust/suffix/src/pins.env), or null when the thread holds no module
 */
export function suffixListPin(): { commit: string; date: string } | null {
	const pin = withInstance(SUFFIX, (instance) => {
		const result = instance.call('', PIN);
		return 'output' in result ? result.output : null;
	});
	if (!pin) return null;
	const [commit, date] = pin.split(' ');
	return commit && date ? { commit, date } : null;
}
