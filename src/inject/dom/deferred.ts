// The document bundle's deferred parts (./deferredParts.ts), the first time
// a document needs one, a group at a time. They are the last statement of the rewriter
// library's file: a proxied top's shell loads it before this bundle, which
// takes the statement's function as it loads (src/inject/rewriter.ts
// deferredFactory). A document under that top evaluates the function's text
// in its own realm (the bundle's), taken from the top, with no request (a
// frame of another slot than its page's, from its slot's agent:
// src/controller/slotLibrary.ts), a frame sandboxed to an opaque origin too
// (its real frame keeps allow-same-origin: it reaches its top). Only a realm
// with neither (a frame under a top of another build, a top the page made)
// asks for the file itself, with the one synchronous request its own copy
// of the light library makes too (the file is read once for both); where
// it cannot be had, each part's hook refuses (deferred-refusals). The
// function is handed this bundle's own modules (stomp:deferred-shared), so
// the parts share the snapshots taken before any page script ran, the
// client and every hook's helpers with the bundle.
import shared from 'stomp:deferred-shared';
import { ACTIVATION_FACTORY, PASSKEYS_FACTORY } from '../../version';
import { deferredFactory } from '../rewriter';
import type { ActivationPart } from './activationPart';
import type { DeferredParts } from './deferredParts';
import type { PasskeysPart } from './passkeysPart';

/** the parts this bundle has evaluated, by name */
const parts = { __proto__: null } as unknown as Partial<DeferredParts>;

/**
 * The deferred part `name`, evaluated with the other parts of its group
 * (build.js partGroups: those of its file, and of files that share a module
 * with it) the first time this realm needs one of them, in the bundle's
 * realm, so a part makes its objects and errors as the bundle's own code
 * does. The statement is one function every group is a case of: a realm
 * compiles it once and makes only the groups it runs. Throws when it cannot
 * be had.
 */
export function deferred<Name extends keyof DeferredParts>(
	name: Name,
): DeferredParts[Name] {
	const part = parts[name];
	if (part !== undefined) return part as DeferredParts[Name];
	const group = deferredFactory(undefined, name)(shared, name) as
		Partial<DeferredParts> | undefined;
	if (!group) throw new Error(`Stomp: the deferred parts have no ${name}`);
	for (const key of Reflect.ownKeys(group) as (keyof DeferredParts)[])
		(parts as Record<string, unknown>)[key] = group[key];
	return group[name] as DeferredParts[Name];
}

/** the passkey provider's client, once this bundle has evaluated it */
let passkeys: PasskeysPart | null = null;

/**
 * The WebAuthn client of STomp's passkey provider (./passkeysPart.ts), a
 * deferred statement of its own, evaluated the first time a document makes
 * a WebAuthn call or asks a PublicKeyCredential static, as a part is.
 * Throws when it cannot be had.
 */
export function passkeysPart(): PasskeysPart {
	if (passkeys) return passkeys;
	const made = deferredFactory(PASSKEYS_FACTORY)(shared) as PasskeysPart;
	passkeys = made;
	return made;
}

/** the activation gates, once this bundle has evaluated them */
let activation: ActivationPart | null = null;

/**
 * The gates of a document's gesture-gated calls (./activationPart.ts), a
 * deferred statement of its own, evaluated the first time a document gets
 * an activation only through the proxy (./activation.ts), as a part is.
 * Throws when it cannot be had.
 */
export function activationPart(): ActivationPart {
	if (activation) return activation;
	const made = deferredFactory(ACTIVATION_FACTORY)(shared) as ActivationPart;
	activation = made;
	return made;
}
