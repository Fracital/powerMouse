import type Client from './Client';

/**
 * Whether the policies of the worker `client` is refuse its request of
 * `directive` for `url` (WorkerClient.requestVerdict, which reports it as
 * the browser does); false in a document, whose requests the service
 * worker judges by its own policies and the browser by its copy of them
 */
export const requestRefused = (
	client: Client,
	directive: string,
	url: URL,
	reportTimes?: number,
	sourced?: boolean,
): boolean =>
	(
		client as {
			requestVerdict?: (
				directive: string,
				url: URL,
				reportTimes?: number,
				sourced?: boolean,
			) => boolean;
		}
	).requestVerdict?.(directive, url, reportTimes, sourced) ?? false;
