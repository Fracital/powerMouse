import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { acceptLanguage } from '../acceptLanguage';
import { mayUsePasskeys, relyingPartyOf } from '../passkeys/rpId';
import type {
	PasskeyCeremony,
	PasskeyCreateOptions,
	PasskeyGetOptions,
	PasskeyOp,
	PasskeyReply,
	PasskeySignal,
	PrfValues,
	Requirement,
} from '../passkeys/types';
import { getDomain, getPublicSuffix } from '../suffix';
import type { HintsDocument } from './clientHints';
import { CHROME_ACCEPT_ENCODING } from './headerOrder';

/**
 * A proxied document's WebAuthn ceremony on its way to the host's
 * authenticator (docs/passkeys.md). The worker is where a request stops
 * being a page's word: the origin and the top origin are the sender's own
 * (its routed URL, its recorded document), the permissions policy is the
 * one the worker recorded for it, the relying party id is checked against
 * that origin as Chrome checks it (its related origins fetched through the
 * proxy, never by the browser), and what goes on is built again from the
 * message, member by member, so the host's page reads nothing but the
 * types it expects.
 */

const NOT_ALLOWED: PasskeyReply = {
	error: [
		'NotAllowedError',
		'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.',
	],
};
const policyRefusal = (feature: string): PasskeyReply => ({
	error: [
		'NotAllowedError',
		`The '${feature}' feature is not enabled in this document. Permissions Policy may be used to delegate Web Authentication capabilities to cross-origin child frames.`,
	],
});

// bounds on what a page may send on: a challenge, a user handle and a
// credential id are short; a list of ids is as long as an account's passkeys
// (and a large blob is at most 2 KiB, the inject's check, Chrome's)
const MAX_BYTES = 4096;
const MAX_TEXT = 1024;
const MAX_LIST = 256;

const bytes = (value: unknown): ArrayBuffer | null =>
	value instanceof ArrayBuffer && value.byteLength <= MAX_BYTES ? value : null;
const text = (value: unknown): string | null =>
	typeof value === 'string' && value.length <= MAX_TEXT ? value : null;
const requirement = (value: unknown): Requirement =>
	value === 'required' || value === 'discouraged' ? value : 'preferred';
function byteList(value: unknown): ArrayBuffer[] | null {
	if (!Array.isArray(value) || value.length > MAX_LIST) return null;
	const out: ArrayBuffer[] = [];
	for (const item of value) {
		const buffer = bytes(item);
		if (!buffer) return null;
		out.push(buffer);
	}
	return out;
}
function prfValues(value: unknown): PrfValues | null {
	if (value === null || typeof value !== 'object') return null;
	const { first, second } = value as Record<string, unknown>;
	const one = bytes(first);
	if (!one) return null;
	if (second === undefined) return { first: one };
	const two = bytes(second);
	return two ? { first: one, second: two } : null;
}

function createOptions(value: unknown): PasskeyCreateOptions | null {
	if (value === null || typeof value !== 'object') return null;
	const given = value as Record<string, unknown>;
	const user = given.user as Record<string, unknown> | null | undefined;
	if (user === null || typeof user !== 'object') return null;
	const id = bytes(user.id);
	const name = text(user.name);
	const displayName = text(user.displayName);
	const rpName = text(given.rpName);
	const challenge = bytes(given.challenge);
	const exclude = byteList(given.exclude);
	const algs = given.algs;
	if (
		!id ||
		id.byteLength > 64 ||
		name === null ||
		displayName === null ||
		rpName === null ||
		!challenge ||
		!exclude ||
		!Array.isArray(algs) ||
		algs.length > MAX_LIST ||
		algs.some((alg) => !Number.isInteger(alg))
	)
		return null;
	const rpId = given.rpId === undefined ? undefined : text(given.rpId);
	const attachment =
		given.attachment === undefined ? undefined : text(given.attachment);
	if (rpId === null || attachment === null) return null;
	let prf: PasskeyCreateOptions['prf'];
	if (given.prf !== undefined) {
		const asked = given.prf as { eval?: unknown } | null;
		if (asked === null || typeof asked !== 'object') return null;
		const values = asked.eval === undefined ? undefined : prfValues(asked.eval);
		if (values === null) return null;
		prf = values ? { eval: values } : {};
	}
	const appid = given.appid === undefined ? undefined : text(given.appid);
	if (appid === null) return null;
	const largeBlob =
		given.largeBlob === undefined
			? undefined
			: given.largeBlob === 'required'
				? 'required'
				: 'preferred';
	// a credBlob of any length is asked for; one too long is not kept
	const credBlob =
		given.credBlob === undefined
			? undefined
			: given.credBlob instanceof ArrayBuffer
				? given.credBlob
				: null;
	if (credBlob === null) return null;
	return {
		...(appid !== undefined ? { appid } : {}),
		...(rpId !== undefined ? { rpId } : {}),
		...(largeBlob ? { largeBlob } : {}),
		...(credBlob ? { credBlob } : {}),
		...(given.conditional === true ? { conditional: true } : {}),
		rpName,
		user: { id, name, displayName },
		challenge,
		algs: algs as number[],
		exclude,
		...(attachment !== undefined ? { attachment } : {}),
		residentKey: requirement(given.residentKey),
		userVerification: requirement(given.userVerification),
		...(prf ? { prf } : {}),
	};
}

function getOptions(value: unknown): PasskeyGetOptions | null {
	if (value === null || typeof value !== 'object') return null;
	const given = value as Record<string, unknown>;
	const challenge = bytes(given.challenge);
	const allow = byteList(given.allow);
	const rpId = given.rpId === undefined ? undefined : text(given.rpId);
	const mediation =
		given.mediation === undefined ? undefined : text(given.mediation);
	if (!challenge || !allow || rpId === null || mediation === null) return null;
	let prf: PasskeyGetOptions['prf'];
	if (given.prf !== undefined) {
		const asked = given.prf as {
			eval?: unknown;
			byCredential?: unknown;
		} | null;
		if (asked === null || typeof asked !== 'object') return null;
		prf = {};
		if (asked.eval !== undefined) {
			const values = prfValues(asked.eval);
			if (!values) return null;
			prf.eval = values;
		}
		if (asked.byCredential !== undefined) {
			const map = asked.byCredential;
			if (map === null || typeof map !== 'object') return null;
			const entries = Object.entries(map as Record<string, unknown>);
			if (entries.length > MAX_LIST) return null;
			prf.byCredential = {};
			for (const [id, each] of entries) {
				const values = prfValues(each);
				if (!values || id.length > MAX_TEXT) return null;
				prf.byCredential[id] = values;
			}
		}
	}
	const appid = given.appid === undefined ? undefined : text(given.appid);
	if (appid === null) return null;
	let largeBlob: PasskeyGetOptions['largeBlob'];
	if (given.largeBlob !== undefined) {
		const asked = given.largeBlob as { read?: unknown; write?: unknown } | null;
		if (asked === null || typeof asked !== 'object') return null;
		if (asked.read === true) largeBlob = { read: true };
		else {
			const write = bytes(asked.write);
			if (!write) return null;
			largeBlob = { write };
		}
	}
	return {
		...(appid !== undefined ? { appid } : {}),
		...(rpId !== undefined ? { rpId } : {}),
		...(largeBlob ? { largeBlob } : {}),
		...(given.getCredBlob === true ? { getCredBlob: true } : {}),
		challenge,
		allow,
		userVerification: requirement(given.userVerification),
		...(mediation !== undefined ? { mediation } : {}),
		...(prf ? { prf } : {}),
	};
}

function signalOf(value: unknown): PasskeySignal | null {
	if (value === null || typeof value !== 'object') return null;
	const given = value as Record<string, unknown>;
	const rpId = text(given.rpId);
	if (rpId === null) return null;
	if (given.kind === 'unknown') {
		const credentialId = text(given.credentialId);
		return credentialId === null
			? null
			: { kind: 'unknown', rpId, credentialId };
	}
	const userId = text(given.userId);
	if (userId === null) return null;
	if (given.kind === 'accepted') {
		const ids = given.ids;
		if (
			!Array.isArray(ids) ||
			ids.length > MAX_LIST * 16 ||
			ids.some((id) => text(id) === null)
		)
			return null;
		return { kind: 'accepted', rpId, userId, ids: ids as string[] };
	}
	if (given.kind === 'details') {
		const name = text(given.name);
		const displayName = text(given.displayName);
		return name === null || displayName === null
			? null
			: { kind: 'details', rpId, userId, name, displayName };
	}
	return null;
}

/** how long a relying party's /.well-known/webauthn may take, redirects and all */
const WELL_KNOWN_MS = 10_000;
/** how much of it is read */
const WELL_KNOWN_BYTES = 256 * 1024;
const WELL_KNOWN_REDIRECTS = 10;

/**
 * `https://<rp id>/.well-known/webauthn` (Level 3, 5.11.1), asked through
 * the proxy as Chrome asks it from its own process (measured, 152 and 156):
 * these headers in this order, no cookies, no referrer, no origin, redirects
 * followed.
 */
async function wellKnown(
	transport: ProxyTransport,
	start: URL,
	userAgent?: string,
): Promise<{ body: string } | 'type' | 'failed'> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), WELL_KNOWN_MS);
	const languages = acceptLanguage(navigator.languages);
	try {
		let url = start;
		for (let hop = 0; hop <= WELL_KNOWN_REDIRECTS; hop++) {
			const response = await transport.request(
				url,
				'GET',
				null,
				[
					['Sec-Fetch-Site', 'none'],
					['Sec-Fetch-Mode', 'no-cors'],
					['Sec-Fetch-Dest', 'empty'],
					['User-Agent', userAgent ?? navigator.userAgent],
					['Accept-Encoding', CHROME_ACCEPT_ENCODING],
					...(languages
						? ([['Accept-Language', languages]] as [string, string][])
						: []),
				],
				abort.signal,
			);
			const header = (wanted: string) =>
				response.headers.find(([name]) => name.toLowerCase() === wanted)?.[1];
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = header('location');
				if (!location) return 'failed';
				url = new URL(location, url);
				if (url.protocol !== 'https:') return 'failed';
				continue;
			}
			if (response.status !== 200) return 'failed';
			if (
				!/^application\/json\s*(;|$)/i.test(
					(header('content-type') ?? '').trim(),
				)
			)
				return 'type';
			const body = await new Response(response.body as BodyInit).text();
			return body.length > WELL_KNOWN_BYTES ? 'failed' : { body };
		}
		return 'failed';
	} catch (error) {
		return 'failed';
	} finally {
		clearTimeout(timer);
	}
}

/** whether a FIDO AppID is `origin`'s own: an https URL of its host or its site */
function ownAppId(
	appid: string,
	origin: URL,
	domainOf: (host: string) => string | null,
): boolean {
	try {
		const url = new URL(appid);
		if (url.protocol !== 'https:') return false;
		if (url.hostname === origin.hostname) return true;
		const site = domainOf(url.hostname);
		return site !== null && site === domainOf(origin.hostname);
	} catch (error) {
		return false;
	}
}

/**
 * The ceremony a document's message makes, or the answer it gets at once.
 * `real` is the sender's real URL, `top` its proxied top's origin (its
 * route's), `doc` the document the worker recorded for it.
 */
export async function passkeyCeremony(
	op: PasskeyOp,
	real: string,
	top: string,
	doc: HintsDocument | null,
	client: string,
	transport: ProxyTransport,
	userAgent?: string,
): Promise<PasskeyCeremony | PasskeyReply> {
	let origin: URL;
	try {
		origin = new URL(real);
	} catch (error) {
		return NOT_ALLOWED;
	}
	if (!mayUsePasskeys(origin)) return NOT_ALLOWED;
	const lookups = {
		domainOf: (host: string) => getDomain(host, true),
		suffixOf: (host: string) => getPublicSuffix(host, true),
		wellKnown: (url: URL) => wellKnown(transport, url, userAgent),
	};
	if (op.op === 'signal') {
		const signal = signalOf(op.signal);
		if (!signal) return NOT_ALLOWED;
		const party = await relyingPartyOf(origin, signal.rpId, lookups);
		if ('error' in party) return party;
		return {
			type: 'signal',
			origin: origin.origin,
			rpId: party.rpId,
			client,
			signal,
		};
	}
	if (op.op !== 'create' && op.op !== 'get') return NOT_ALLOWED;
	// the document's policy, as the worker recorded it; a document it does
	// not know is judged by the default allowlist (its top's origin only)
	const feature =
		op.op === 'create'
			? 'publickey-credentials-create'
			: 'publickey-credentials-get';
	const allowed = doc
		? doc.allFeatures.get(feature) !== false
		: top === origin.origin;
	if (!allowed) return policyRefusal(feature);
	const options =
		op.op === 'create' ? createOptions(op.options) : getOptions(op.options);
	if (!options) return NOT_ALLOWED;
	const party = await relyingPartyOf(origin, options.rpId, lookups);
	if ('error' in party) return party;
	// a FIDO AppID (the appid and appidExclude extensions) must be the
	// origin's own site's, over https; nothing here holds a U2F credential,
	// so that check is all the extension does
	if (
		options.appid !== undefined &&
		!ownAppId(options.appid, origin, lookups.domainOf)
	)
		return { error: ['SecurityError', 'This is an invalid domain.'] };
	// in a frame of another origin: the page cannot say it is not
	const crossOrigin =
		op.sameOriginWithAncestors !== true || top !== origin.origin;
	const context = {
		origin: origin.origin,
		...(crossOrigin ? { topOrigin: top } : {}),
		rpId: party.rpId,
		client,
	};
	return op.op === 'create'
		? { ...context, type: 'create', options: options as PasskeyCreateOptions }
		: { ...context, type: 'get', options: options as PasskeyGetOptions };
}
