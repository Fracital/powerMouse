import { RouteContext } from '../transport/messages';

export function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data, null, '\t'), {
		status,
		headers: {
			'content-type': 'application/json',
		},
	});
}

class HttpError extends Error {
	status: number;
	title: string;
	constructor(status: number, title: string, message?: string) {
		super(message || title);
		this.title = title || status.toString();
		this.status = status;
	}
}

class NotFound extends HttpError {
	constructor(message?: string) {
		super(404, 'Not Found', message);
	}
}

class InternalServerError extends HttpError {
	constructor(message?: string) {
		super(500, 'Internal Server Error', message);
	}
}

function isHttpError(err: unknown): err is HttpError {
	if (!(err instanceof Error)) return false;
	return (
		typeof (
			err as {
				[K in keyof HttpError]: HttpError[K] | unknown;
			}
		).status === 'number'
	);
}

export default class Router {
	private directory: string;
	routes: Map<
		RegExp,
		(
			request: Request,
			url: string,
			context?: RouteContext,
		) => Promise<Response> | Response
	>;
	/** the host's page for a failed document (createServer sets it from the config) */
	errorPage?: (
		request: Request,
		status: number,
		message: string,
	) => Promise<Response | null>;
	constructor(directory: string) {
		this.directory = directory;
		this.routes = new Map();
	}
	private resolveURL(fullURL: string): string {
		return '/' + new URL(fullURL).pathname.slice(this.directory.length);
	}
	willRoute(fullURL: string): boolean {
		const url = this.resolveURL(fullURL);

		for (const regex of this.routes.keys()) {
			if (regex.test(url)) {
				return true;
			}
		}

		return false;
	}
	async tryRoute(request: Request, context?: RouteContext): Promise<Response> {
		const url = this.resolveURL(request.url);

		for (const [regex, value] of this.routes) {
			if (regex.test(url)) {
				return value(request, url, context);
			}
		}

		throw new NotFound(`${request.url} shouldn't have been routed`);
	}
	async route(request: Request, context?: RouteContext): Promise<Response> {
		try {
			return await this.tryRoute(request, context);
		} catch (err) {
			console.error(`At ${request.method} ${request.url}`);
			console.error(err);

			let httpError: HttpError;
			let id: string | undefined;

			if (isHttpError(err)) {
				httpError = err;
			} else {
				if (err instanceof Error) {
					httpError = new InternalServerError(err.toString());
					console.error(err.stack);
					id = err.name;
				} else {
					httpError = new InternalServerError(String(err));
					id = 'UNKNOWN';
				}
			}

			if (
				request.destination === 'document' ||
				request.destination === 'iframe' ||
				request.destination === 'frame'
			) {
				const host = await this.errorPage?.(
					request,
					httpError.status,
					httpError.message,
				);
				if (host) return host;
				return new Response(
					`<!DOCTYPE HTML>
<html>
<head>
<meta charset='utf-8' />
<title>Error</title>
</head>
<body>
<h1>An error occurred. (${httpError.status})</h1>
<hr />
<p>Code: <span id='errname'></span></p>
<p>ID: <span id='errid'></span></p>
<p>Message: <span id='errmessage'></span></p>
<p>Stack trace:</p>
<pre id='errstack'></pre>
<script>
const name = ${JSON.stringify(httpError.name)};
const stack = ${JSON.stringify(httpError.stack)};
const message = ${JSON.stringify(httpError.message)};
const id = ${JSON.stringify(id)};

errname.textContent = name;
errmessage.textContent = message;
errstack.textContent = stack;
errid.textContent = id;

const error = new Error(message);
error.name = name;
error.stack = stack;
console.error(error);
</script>
</body>
</html>`,
					{
						status: httpError.status,
						headers: {
							'content-type': 'text/html',
						},
					},
				);
			} else {
				return json(httpError.status, {
					message: httpError.message,
					status: httpError.status,
				});
			}
		}
	}
}

export function jsonAPI(callback: (...args: any[]) => any) {
	return async (request: Request): Promise<Response> => {
		try {
			const result = await callback(...(await request.json()));
			return json(200, result === undefined ? null : result);
		} catch (error) {
			return json(500, String(error));
		}
	};
}
