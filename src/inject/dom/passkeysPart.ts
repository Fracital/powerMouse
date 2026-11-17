// The WebAuthn client of STomp's passkey provider (./passkeys.ts), the
// deferred statement `__stompPasskeys=function(__stompShared){...};`
// (src/version.ts PASSKEYS_FACTORY), after the deferred parts' in the light
// rewriter library's file. It is a statement of its own and not one of the
// deferred parts (./deferredParts.ts) because a frame that needs any part
// evaluates all of them, and most documents never call WebAuthn: only one
// that does compiles this (./deferred.ts passkeysPart). It shares the
// bundle's modules as the parts do (build.js DEFERRED_FILES), with the same
// rules: its top level reads no global.
import { passkeys } from './passkeys';

const part = { passkeys };

export type PasskeysPart = typeof part;

// what the statement's function returns (build.js: its banner makes the
// object, its footer returns `made`), as the deferred parts hand theirs over
declare const __stompParts: { made?: PasskeysPart };
__stompParts.made = part;
