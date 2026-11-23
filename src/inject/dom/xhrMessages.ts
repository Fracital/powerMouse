// The browser's messages for a page's misuse of XMLHttpRequest
// (./modules/XMLHttpRequest.ts), which the module throws in its place. A
// deferred part of the document bundle (./deferredParts.ts): a page that
// uses the API as it is meant to never gets one. (A network error's stays
// in the module: the network that failed may be what loads the parts.)

const SET = (name: string) =>
	`Failed to set the '${name}' property on 'XMLHttpRequest': `;
const READ = (name: string, types: string, type?: string) =>
	`Failed to read the '${name}' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or '${types}' (was '${type}').`;
const RUN = (name: string) =>
	`Failed to execute '${name}' on 'XMLHttpRequest': `;

const MESSAGES = {
	timeout: () =>
		`${SET('timeout')}Timeouts cannot be set for synchronous requests made from a document.`,
	withCredentials: () =>
		`${SET('withCredentials')}The value may only be set if the object's state is UNSENT or OPENED.`,
	responseText: (type?: string) => READ('responseText', 'text', type),
	responseXML: (type?: string) => READ('responseXML', 'document', type),
	responseTypeLate: () =>
		`${SET('responseType')}The response type cannot be set if the object's state is LOADING or DONE.`,
	responseTypeSync: () =>
		`${SET('responseType')}The response type cannot be changed for synchronous requests made from a document.`,
	responseTypeValue: (value?: string) =>
		`The provided value '${value}' is not a valid enum value of type XMLHttpRequestResponseType.`,
	overrideMimeType: () =>
		`${RUN('overrideMimeType')}MimeType cannot be overridden when the state is LOADING or DONE.`,
	url: () => `${RUN('open')}Invalid URL`,
	open: () =>
		`${RUN('open')}Synchronous requests from a document must not set a response type or timeout.`,
};

export type XhrMessage = keyof typeof MESSAGES;

/** the browser's message `key`, with what it names (a response type, a value) */
export function xhrMessage(key: XhrMessage, detail?: string): string {
	return MESSAGES[key](detail);
}
