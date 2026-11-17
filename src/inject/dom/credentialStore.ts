// What a password or federated credential request gets until STomp keeps
// a store of each site's own (src/inject/dom/modules/Credentials.ts): the
// error Chrome gives a frame by its ancestors' origins (measured, Chrome 157,
// credentials-password suite), or null at the top, which finds none.

/** `[message, name]` of the error a document under these ancestors gets, or null */
export function ownStoreRefusal(
	ancestors: string[],
	origin: string,
): [string, string] | null {
	if (ancestors.some((ancestor) => ancestor !== origin))
		return [
			"The following credential operations can only occur in a document which is same-origin with all of its ancestors: storage/retrieval of 'PasswordCredential' and 'FederatedCredential', storage of 'PublicKeyCredential'.",
			'NotAllowedError',
		];
	return ancestors.length
		? [
				'Error connecting to Credential Management service.',
				'NotSupportedError',
			]
		: null;
}
