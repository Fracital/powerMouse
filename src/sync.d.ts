export interface SerializableRequestInit extends Omit<
	Omit<Omit<RequestInit, 'signal'>, 'headers'>,
	'body'
> {
	headers?: { [key: string]: string | string[] };
}

export interface ProcessData {
	url: string;
	init: SerializableRequestInit;
	body?: string;
	/** a binary request body, its bytes in base64 */
	bodyBase64?: string;
}

/**
 * A response body travels as bytes: UTF-8 text as the string it decodes to
 * (the page encodes it back to the same bytes), anything else in base64.
 */
export interface SyncBody {
	text?: string;
	base64?: string;
}

export type ProcessResult =
	| {
			error?: { message: string };
	  }
	| (SyncBody & {
			init: ResponseInit;
			url: string;
	  });
