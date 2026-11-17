// The document bundle's deferred parts (./deferredParts.ts), the first time
// a document needs one. They are the last statement of the rewriter
// library's file: a proxied top's shell loads it before this bundle, which
// takes the statement's function as it loads (src/inject/rewriter.ts
// deferredFactory). A document under that top evaluates the function's text
// in its own realm (the bundle's), taken from the top, with no request (a
// frame of another slot than its page's, from its slot's agent:
// src/controller/slotLibrary.ts). Only a realm with neither (a frame
// sandboxed to an opaque origin, a frame under a top of another build, a top
// the page made) asks for the file
// itself, with the one synchronous request its own copy of the light library
// makes too (the file is read once for both). The function is handed this
// bundle's own modules (stomp:deferred-shared), so the parts share the
// snapshots taken before any page script ran, the client and every hook's
// helpers with the bundle.
import shared from 'stomp:deferred-shared';
import { ACTIVATION_FACTORY, PASSKEYS_FACTORY } from '../../version';
import { deferredFactory } from '../rewriter';
import type { ActivationPart } from './activationPart';
import type { DeferredParts } from './deferredParts';
import type { PasskeysPart } from './passkeysPart';

/** the parts, once this bundle has evaluated them */
let parts: DeferredParts | null = null;

/**
 * The deferred parts, evaluated the first time this is called (in the
 * bundle's realm, so a part makes its objects and errors as the bundle's
 * own code does). Throws when they cannot be had.
 */
export function deferred(): DeferredParts {
	if (parts) return parts;
	const made = deferredFactory()(shared()) as DeferredParts;
	parts = made;
	return made;
}

/** the passkey provider's client, once this bundle has evaluated it */
let passkeys: PasskeysPart | null = null;

/**
 * The WebAuthn client of STomp's passkey provider (./passkeysPart.ts), a
 * deferred statement of its own, evaluated the first time a document makes
 * a WebAuthn call or asks a PublicKeyCredential static, as deferred() is.
 * Throws when it cannot be had.
 */
export function passkeysPart(): PasskeysPart {
	if (passkeys) return passkeys;
	const made = deferredFactory(PASSKEYS_FACTORY)(shared()) as PasskeysPart;
	passkeys = made;
	return made;
}

/** the activation gates, once this bundle has evaluated them */
let activation: ActivationPart | null = null;

/**
 * The gates of a document's gesture-gated calls (./activationPart.ts), a
 * deferred statement of its own, evaluated the first time a document gets
 * an activation only through the proxy (./activation.ts), as deferred() is.
 * Throws when it cannot be had.
 */
export function activationPart(): ActivationPart {
	if (activation) return activation;
	const made = deferredFactory(ACTIVATION_FACTORY)(shared()) as ActivationPart;
	activation = made;
	return made;
}
