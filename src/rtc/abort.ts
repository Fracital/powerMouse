// What a data channel's `error` event says when the peer ended the SCTP
// association with an ABORT chunk (docs/webrtc-over-wisp.md, section 15).
// Chrome's stack reports such an end as an RTCError of detail
// "sctp-failure" whose sctpCauseCode is 12 (User-Initiated Abort) whatever
// cause the chunk carried, and whose message words the chunk's first
// cause. Measured for the cause Chrome itself sends when a page closes its
// connection: "User-Initiated Abort, reason=Close called". The words for
// a Protocol Violation follow the same stack's source and are unmeasured;
// any other cause, and a chunk without one, gives an empty message.

export interface PeerAbort {
	cause: number;
	message: string;
}

const USER_INITIATED_ABORT = 12;
const PROTOCOL_VIOLATION = 13;

/** `code` and `hex` are the chunk's first cause: its code and its value */
export function peerAbort(code: number, hex: string): PeerAbort {
	const bytes = new Uint8Array(hex.length >> 1);
	for (let at = 0; at < bytes.length; at++)
		bytes[at] = parseInt(hex.slice(at * 2, at * 2 + 2), 16);
	const text = new TextDecoder().decode(bytes);
	let message = '';
	if (code === USER_INITIATED_ABORT)
		message = `User-Initiated Abort, reason=${text}`;
	else if (code === PROTOCOL_VIOLATION)
		message = `Protocol Violation, additional_information=${text}`;
	return { cause: USER_INITIATED_ABORT, message };
}
