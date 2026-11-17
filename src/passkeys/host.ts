// The host application's side of a passkey ceremony (docs/passkeys.md): the
// service worker, which holds the keys and decides who asks, sends the
// controller a prompt; this asks the host's `passkeys.onRequest` and hands
// back what the user said. Nothing here makes or signs anything.
import {
	PASSKEY_CANCEL,
	type PasskeyAnswer,
	type PasskeyPrompt,
	type PasskeyRequest,
	type PasskeysInit,
} from './types';

/**
 * Ask the host about one ceremony. `port` hears PASSKEY_CANCEL (or closes)
 * when the page gives up, which aborts the request's signal. Resolves the
 * host's answer, or null when it declined, threw or the page gave up.
 */
export async function askHost<Request extends PasskeyRequest>(
	init: PasskeysInit<Request>,
	prompt: PasskeyPrompt,
	port: MessagePort,
	extra: Omit<Request, keyof PasskeyRequest>,
): Promise<PasskeyAnswer | null> {
	const abort = new AbortController();
	const cancel = () => abort.abort();
	port.addEventListener('message', (event) => {
		if (event.data === PASSKEY_CANCEL) cancel();
	});
	port.addEventListener('close', cancel);
	port.start();
	try {
		const answer = await init.onRequest({
			...prompt,
			...extra,
			signal: abort.signal,
		} as Request);
		if (abort.signal.aborted || answer === null || typeof answer !== 'object')
			return null;
		return {
			...(typeof answer.credential === 'string'
				? { credential: answer.credential }
				: {}),
			...(answer.userVerified === true ? { userVerified: true } : {}),
		};
	} catch (error) {
		return null;
	} finally {
		port.close();
	}
}
