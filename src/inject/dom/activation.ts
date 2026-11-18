// A document's user activation as the browser gives it natively. Every
// proxied document is of one real origin, so Chrome's activation reaches
// all of them: an input event activates its frame, every ancestor of it
// and every frame of its origin in the page (Frame::NotifyUserActivationIn
// FrameTree, measured in Chrome 157), and to the browser every proxied
// frame is of its origin, in every tab of the host's page, and so is the
// host's own page in same-origin mode. Natively the frames of another
// origin (another site's, an opaque one) and the frames of other tabs
// gain nothing. So each input event in a proxied document (the Navigate
// module listens) walks the page's frames and tells each document whether
// the event's activation is its own natively: then it is noted as one, and
// else as one it only has from the proxy. The host's own input in
// same-origin mode is of the second kind for every proxied document (the
// controller tells them).
//
// A document that ever got one of the second kind then answers its
// activation as natively: navigator.userActivation, the inject's own reads
// (a frame's navigation of its top), and every call that needs a transient
// activation (or a sticky one) refuses as the browser does without one.
// The browser's own activation stays necessary: nothing is granted that the
// browser would not grant. A document no foreign activation ever reached
// keeps the browser's answers and none of the hooks: they are made in its
// realm the first time it gets one (an input event elsewhere, or its
// start: an ad frame a click reached that loads its next ad), with bodies
// that ask the rules (./activationGates.ts, a deferred statement the
// proxied top evaluates once) only while the activation is the proxy's
// alone; its page's code may have taken a native before, and then calls
// it with the browser's answer.
//
// The browser carries a sticky activation over to the next document of the
// same origin in a frame (measured: a link of the origin, a script's
// navigation), and to the browser every proxied document is of one origin.
// A document that starts with one keeps it when its referrer (the document
// that navigated, as the worker decided it) is of its own origin.
//
// Left: an activation the browser consumed in another frame (a popup, a
// fullscreen request) and then gave again through the proxy, within the
// five seconds of an earlier one of the document's own, reads as active;
// the activation automation gives without an input event (an evaluation)
// is the browser's, whoever it reaches; a media element's autoplay
// attribute plays as the browser decides it.
import ProxyModule from '../modules/Proxy';
import type DocumentClient from './Client';

/** Chrome's transient activation lasts five seconds (kActivationLifespan) */
export const LIFESPAN = 5000;

/** what a document knows of the activations that reached it */
export interface ActivationNote {
	/** when an activation of its own last reached it */
	own: number;
	/** when one from the proxy last reached it */
	foreign: number;
	/** when one from the proxy last reached it from an input event (not its start) */
	input: number;
	/** whether one of its own ever did (or it started with one carried over) */
	ownSticky: boolean;
	/** whether its sticky activation is from the proxy alone */
	foreignSticky: boolean;
	/** when this document's own input last walked the frames */
	walked: number;
	/** whether the hooks are in its realm */
	hooked: boolean;
	/** what makes its realm's wrappers (its Proxy module, the bodies of its bundle by kind), once hooked */
	wrap?: [ProxyModule, GateBody[]];
	/** the interfaces whose members were hooked when the page reached them */
	reached?: string[];
}

/** a gated member's wrapper's body */
export type GateBody = (
	fn: Function,
	that: unknown,
	args: unknown[],
) => unknown;

/** taken before the page runs: a window's own accessor answers for any window */
export const nativeLength = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'length',
)?.get;

/**
 * The document's user activation: bit 1 transient, bit 2 sticky, as
 * natively; bit 4 and bit 8 the browser's own (transient, sticky)
 */
export function activationState(client: DocumentClient): number {
	const natives = client.historyActivation?.natives;
	let active = false;
	let sticky = false;
	try {
		if (natives) {
			active = Reflect.apply(natives[0], natives[2], []) === true;
			sticky = Reflect.apply(natives[1], natives[2], []) === true;
		} else {
			const activation = client.global.navigator.userActivation;
			active = activation?.isActive === true;
			sticky = activation?.hasBeenActive === true;
		}
	} catch (error) {
		// no user activation API
	}
	const browser = (active ? 4 : 0) | (sticky ? 8 : 0);
	const note = client.activation;
	if (note) {
		const now = Date.now();
		if (active && now - note.foreign < LIFESPAN && now - note.own >= LIFESPAN)
			active = false;
		if (active && popupConsumed(client, note, now)) active = false;
		if (sticky && note.foreignSticky && !note.ownSticky) sticky = false;
		sticky ||= active;
	}
	return browser | (active ? 1 : 0) | (sticky ? 2 : 0);
}

/** the client that keeps what consumed `client`'s tab's activation: its proxied top's, else its own */
function tabClient(client: DocumentClient): DocumentClient {
	try {
		const top = (client.proxiedTop as Record<string, any>)[client.names.client];
		if (top && top.global === client.proxiedTop) return top as DocumentClient;
	} catch (error) {
		// the proxied top went away
	}
	return client;
}

/**
 * Whether `client`'s document may have a popup the browser does not open
 * itself (a tab the host opens for it), as Chrome's popup blocker decides:
 * only with a transient activation, and one popup for each (opening one
 * consumes it, in every document of the tab; measured in Chrome 157: a
 * second window.open() in the same click answers null, and so does one
 * after a target=_blank link's click). The host's tab leaves the browser's
 * activation as it was, so the consumption is kept here, by the tab's
 * proxied top: an activation an input event gave is consumed until the
 * next input event. One automation gives with no input event is told from
 * the next by nothing, and is not consumed.
 */
export function mayOpenPopup(client: DocumentClient): boolean {
	return (activationState(client) & 1) !== 0;
}

/**
 * Whether a tab the host opened consumed the activation an input event
 * gave `client`'s document (mayOpenPopup)
 */
function popupConsumed(
	client: DocumentClient,
	note: ActivationNote,
	now: number,
): boolean {
	const input = Math.max(note.own, note.input);
	if (now - input >= LIFESPAN) return false;
	return (tabClient(client).popupConsumed ?? -Infinity) >= input;
}

/**
 * A tab the host opened for `client`'s document consumed the tab's
 * activation (mayOpenPopup): from then on the document answers as without
 * one (navigator.userActivation.isActive false, as natively), its gated
 * calls hooked as for an activation it got through the proxy
 */
export function popupOpened(client: DocumentClient) {
	tabClient(client).popupConsumed = Date.now();
	if (client.activation) hookGates(client, client.activation);
}

/**
 * An input event that activates (the Navigate module filtered it) in
 * `client`'s document: every proxied document of the page is told whether
 * the activation is its own natively (./activationGates.ts walkInput, a
 * deferred statement)
 */
export function noteInput(client: DocumentClient) {
	try {
		client.activationGatesPart().walkInput(client);
	} catch (error) {
		// no deferred statement: the browser's activation
	}
}

/**
 * An activation reached `client`'s document at `at`: its own natively, or
 * (`foreign`) only through the proxy. `start` notes the sticky activation
 * a document started with, from the proxy; `input` that an input event
 * gave it (not its start). Called in the document's own
 * realm (its client's `markActivation`), so the hooks it makes the first
 * time are the realm's.
 */
export function markActivation(
	client: DocumentClient,
	foreign: boolean,
	at: number,
	start = false,
	input = true,
) {
	const note = (client.activation ??= {
		own: -Infinity,
		foreign: -Infinity,
		input: -Infinity,
		ownSticky: false,
		foreignSticky: false,
		walked: -Infinity,
		hooked: false,
	});
	if (!foreign) {
		note.own = at;
		note.ownSticky = true;
		return;
	}
	if (!start) note.foreign = at;
	if (input) note.input = at;
	if (!note.ownSticky) note.foreignSticky = true;
	hookGates(client, note);
}

/** the gated calls' hooks in `client`'s realm, made once */
function hookGates(client: DocumentClient, note: ActivationNote) {
	if (note.hooked) return;
	note.hooked = true;
	// the hooks' rules are a deferred statement (./activationPart.ts), the
	// top's: only the wrappers and their bodies are this realm's
	try {
		client
			.activationGatesPart()
			.activationGates(client, client.getModule(ProxyModule)!, [
				gateBody(client, 0),
				gateBody(client, 1),
				gateBody(client, 2),
			]);
	} catch (error) {
		// no deferred statement: the browser's answers
	}
}

/**
 * The body of the wrappers of the gated members of a `kind` in `client`'s
 * realm (one for all of them: the rules tell each by its native): the
 * native's call, unless the activation `kind` asks about (1 transient, 2
 * sticky, 0 any call) is the browser's and not the document's, and then the
 * rule's (./activationGates.ts gated)
 */
function gateBody(client: DocumentClient, kind: number): GateBody {
	return (fn: Function, that: unknown, args: unknown[]) => {
		const state = activationState(client);
		return kind === 0 || (state & (kind | (kind << 2))) === kind << 2
			? client.activationGatesPart().gated(client, fn, that, args)
			: Reflect.apply(fn, that, args);
	};
}
