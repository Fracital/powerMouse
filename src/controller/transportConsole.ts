// The host's console for the transport's notes (src/transport/transportLog.ts):
// the controller that is the host's (StompController in the same-origin
// mode, StompRemoteController in the isolated one) prints each one as it
// came, one plain line, info or warn.
import type { TransportNote } from '../transport/transportLog';

/** the host origin's localStorage key that turns the verbose mode on ('1') */
export const DEBUG_TRANSPORT_KEY = 'stomp:debug-transport';

/** whether the host origin's storage asks for the verbose mode */
export function debugTransportStored(): boolean {
	try {
		return globalThis.localStorage?.getItem(DEBUG_TRANSPORT_KEY) === '1';
	} catch {
		// storage this page may not read
		return false;
	}
}

/** a note on the console */
export function printNote(note: TransportNote) {
	if (note.level === 'warn') console.warn(note.text);
	else console.info(note.text);
}
