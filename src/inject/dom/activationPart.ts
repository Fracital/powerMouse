// The gates of a document's gesture-gated calls, and the walk of the page's
// frames an input event makes (./activationGates.ts), the
// deferred statement `__stompActivation=function(__stompShared){...};`
// (src/version.ts ACTIVATION_FACTORY), after the passkey provider's in the
// light rewriter library's file. A statement of its own and not one of the
// deferred parts (./deferredParts.ts): a click reaches every frame of the
// page through the proxy, so every frame of another site a click elsewhere
// reaches needs the gates, and evaluating all the parts for that would cost
// each such frame several times what the gates do. It shares the bundle's
// modules as the parts do (build.js DEFERRED_FILES), with the same rules:
// its top level reads no global.
import { activationGates, walkInput } from './activationGates';

const part = { activationGates, walkInput };

export type ActivationPart = typeof part;

// what the statement's function returns (build.js: its banner makes the
// object, its footer returns `made`), as the deferred parts hand theirs over
declare const __stompParts: { made?: ActivationPart };
__stompParts.made = part;
