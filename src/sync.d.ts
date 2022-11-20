export interface SerializableRequestInit
	extends Omit<Omit<Omit<RequestInit, 'signal'>, 'headers'>, 'body'> {
	headers?: { [key: string]: string | string[] };
}

export interface ProcessData {
	url: string;
	init: SerializableRequestInit;
	body?: string;
}

export type ProcessResult =
	| {
			error?: { message: string };
	  }
	| {
			textArrayBuffer: string;
			init: ResponseInit;
			url: string;
	  };
