// What the worker decides a top-level navigation's opener policy by
// (src/coop.ts OpenerFacts), and whether window.open opens without an
// opener for that reason (dom/modules/NavigationHint.ts, IFrame.ts): a
// deferred part of the document bundle (./deferredParts.ts), made at a
// document's first navigation hint or window.open that may need it, which
// most documents never make. Its top level reads no global.
//
// A popup's first navigation goes from its initial about:blank, whose
// policy is its creator's top's when the creator is of that top's origin,
// and whose window has the policy its creator's real top has (the host's
// tab: none). Any other is the navigation of the real top this document is
// in, from the document it shows; in the host's frame there is none (a
// frame's navigation).
import type { NavigationHintMessage } from '../../transport/messages';
import type DocumentClient from './Client';
import { SAME_FRAME } from './links';
import { initialBlank } from './modules/Context';

type Facts = NonNullable<NavigationHintMessage['coop']>;

const clientOf = (
	client: DocumentClient,
	context: unknown,
): DocumentClient | null => {
	try {
		const found = (context as Record<string, unknown>)[client.names.client] as
			DocumentClient | undefined;
		return found?.isDOM ? found : null;
	} catch (error) {
		// a window of another real origin
		return null;
	}
};

/**
 * Whether a document of another origin than a top-level page with COOP
 * same-origin is `client`'s: it opens every popup without an opener, and
 * window.open returns null (measured in Chrome 157, the coop suite)
 */
export function opensWithoutOpener(client: DocumentClient): boolean {
	// the site pool: a frame of another slot than its top's, which it cannot
	// reach, is of another origin, and its route says what that top sent
	// (partition.ts nestedMark)
	if (client.nested && client.slotMark?.topOpenerSameOrigin) return true;
	// Chrome opens a credentialless frame's popups without an opener
	if (client.credentiallessNonce !== null) return true;
	const top = clientOf(client, client.proxiedTop);
	return (
		!!top &&
		top !== client &&
		top.scriptFacts.coop?.[0] === 'same-origin' &&
		top.originKey !== client.originKey
	);
}

function creatorFacts(creator: DocumentClient): Facts {
	const top = clientOf(creator, creator.proxiedTop);
	let origin = creator.originKey;
	const topPolicy = top?.scriptFacts.coop?.[0] ?? '';
	let policy = '';
	if (top && origin !== null && origin === top.originKey) policy = topPolicy;
	else if (top && topPolicy === 'same-origin') {
		// a creator of another origin than a top with COOP same-origin: its
		// popup leaves the group (opensWithoutOpener) and its name goes,
		// whatever the popup's policy
		policy = topPolicy;
		origin = top.originKey;
	}
	let real = '';
	try {
		real = clientOf(creator, creator.global.top)?.scriptFacts.coop?.[1] ?? '';
	} catch (error) {
		// the host's page, of another origin
	}
	return [true, policy, origin ?? 'null', real];
}

/**
 * The facts of `client`'s navigation: `opening` is true for window.open,
 * a link's or a form's target and whether a modifier opens a new window
 * for those, nothing for a navigation of the document's own window.
 * `nativeOpener` is a window's opener getter, as the bundle took it
 */
export function openerFacts(
	client: DocumentClient,
	opening: true | [target: string | null, modifier: boolean] | undefined,
	nativeOpener: () => unknown,
): Facts | undefined {
	if (opening !== undefined && opening !== true) {
		const [target, modifier] = opening;
		const name = (
			target ||
			client.global.document
				.querySelector('base[target]')
				?.getAttribute('target') ||
			''
		).toLowerCase();
		opening =
			modifier ||
			(!SAME_FRAME.includes(name) && !client.hasFrameNamed(name)) ||
			undefined;
	}
	if (opening) return creatorFacts(client);
	let top: typeof globalThis | null;
	try {
		top = client.global.top as typeof globalThis | null;
	} catch (error) {
		return undefined;
	}
	const topClient = clientOf(client, top);
	if (!top || !topClient) return undefined;
	if (initialBlank(top)) {
		let opener: unknown = null;
		try {
			opener = Reflect.apply(nativeOpener, top, []);
		} catch (error) {
			// torn down
		}
		const creator = clientOf(client, opener);
		return creator ? creatorFacts(creator) : undefined;
	}
	const coop = topClient.scriptFacts.coop;
	return [
		false,
		coop?.[0] ?? '',
		topClient.originKey ?? 'null',
		coop?.[1] ?? '',
	];
}
