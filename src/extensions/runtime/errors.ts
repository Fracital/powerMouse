// What an extension's context tells Chrome's error console (the extensions
// page's Errors view, docs/extensions.md "Errors"): its uncaught errors and
// unhandled rejections, its listeners' errors, and its console.error and
// console.warn calls (console.error only in a service worker, as Chrome's
// worker console reports no warning), each with its stack. Sent to the
// worker only while it collects them (developer mode on and Collect errors
// on for the extension): the registry flips that over the bus.
import type { ReportedError } from '../types';
import type { Context } from './context';
import { natives } from './natives';
import { methodLike } from './present';

type Frame = ReportedError['stackTrace'][number];

/** V8's stack lines: `at fn (url:line:col)` or `at url:line:col` */
const STACK_LINE = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;

/** the runtime's own frames (its bundle) are no part of the extension's stack */
const OWN =
	/\/(extensionsRuntime|injectDocument(Full)?|injectWorker(Full)?)\.js/;

function framesOf(stack: unknown): Frame[] {
	if (typeof stack !== 'string') return [];
	const frames: Frame[] = [];
	for (const line of stack.split('\n')) {
		const found = STACK_LINE.exec(line);
		if (!found) continue;
		const url = found[2];
		if (OWN.test(url)) continue;
		frames.push({
			url,
			lineNumber: Number(found[3]),
			columnNumber: Number(found[4]),
			functionName: found[1] ?? '',
		});
	}
	return frames;
}

/** an error's text as the console prints it (`Error: boom`) */
function described(error: unknown): string {
	if (error !== null && typeof error === 'object') {
		try {
			const { name, message } = error as { name?: unknown; message?: unknown };
			if (typeof message === 'string')
				return `${typeof name === 'string' && name ? name : 'Error'}: ${message}`;
		} catch (thrown) {
			// a revoked proxy, a throwing getter: as a string then
		}
	}
	try {
		return String(error);
	} catch (thrown) {
		return 'Error';
	}
}

/** console arguments as one line, as Chrome's console message reads them */
function line(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === 'string') return arg;
			if (arg instanceof Error) return described(arg);
			if (arg !== null && typeof arg === 'object')
				try {
					return natives.JSON.stringify(arg);
				} catch (error) {
					return String(arg);
				}
			return String(arg);
		})
		.join(' ');
}

export interface ErrorConsole {
	/** an error a listener of the extension's threw */
	listener(error: unknown): void;
	/** an uncaught error, from where the context runs code (an isolated world's scripts) */
	uncaught(error: unknown): void;
}

/**
 * Report the context's errors while the extension's errors are collected;
 * `win` is the window whose errors are the context's (an extension page's
 * own, none for a content context, whose page's errors are the page's)
 */
export function errorConsole(
	ctx: Context,
	options: {
		win: (Window & typeof globalThis) | null;
		/** the console whose error and warn calls are the context's */
		console: Console | null;
		contextUrl: () => string;
		serviceWorker?: boolean;
		/**
		 * the context is no page of a tab (a background, a service worker's
		 * stand-in, an offscreen document): its errors reach no web page's
		 * console, as in Chrome, where only its own DevTools see them
		 */
		hidden?: () => boolean;
	},
): ErrorConsole {
	let collecting = ctx.ext.collect === true;
	ctx.on('collect', (message) => {
		collecting = message.on === true;
	});
	const send = (
		message: string,
		severity: 'warn' | 'error',
		stackTrace: Frame[],
	) => {
		if (!collecting) return;
		const reported: ReportedError = {
			message,
			severity,
			stackTrace,
			contextUrl: options.contextUrl(),
			...(options.serviceWorker ? { isServiceWorker: true } : {}),
		};
		ctx.worker('errors', 'report', reported).catch(() => {});
	};
	const here = () => framesOf(new Error().stack);
	const uncaught = (error: unknown, prefix = 'Uncaught') =>
		send(
			`${prefix} ${described(error)}`,
			'error',
			error !== null && typeof error === 'object'
				? framesOf((error as { stack?: unknown }).stack)
				: here(),
		);
	const win = options.win;
	if (win) {
		win.addEventListener('error', (event: ErrorEvent) => {
			if (!(event instanceof win.ErrorEvent)) return;
			if (options.hidden?.()) event.preventDefault();
			const frames =
				event.error !== null && typeof event.error === 'object'
					? framesOf((event.error as { stack?: unknown }).stack)
					: [];
			send(
				event.message || `Uncaught ${described(event.error)}`,
				'error',
				frames.length
					? frames
					: event.filename
						? [
								{
									url: event.filename,
									lineNumber: event.lineno,
									columnNumber: event.colno,
									functionName: '',
								},
							]
						: [],
			);
		});
		win.addEventListener('unhandledrejection', (event) => {
			if (options.hidden?.()) event.preventDefault();
			uncaught(event.reason, 'Uncaught (in promise)');
		});
	}
	const target = options.console;
	if (target) {
		const wrap = (name: 'error' | 'warn') => {
			const original = target[name];
			if (typeof original !== 'function') return;
			// (shown as the native: present.ts methodLike)
			const wrapped = methodLike({ name, length: 0 }, function (args) {
				send(line(args), name, here());
				return Reflect.apply(original, this, args);
			});
			try {
				target[name] = wrapped;
			} catch (error) {
				// a read-only console member
			}
		};
		wrap('error');
		// (a service worker's console.warn reaches no error console in Chrome)
		if (!options.serviceWorker) wrap('warn');
	}
	return {
		listener: (error) =>
			send(
				`Error in event handler: ${described(error)}`,
				'error',
				error !== null && typeof error === 'object'
					? framesOf((error as { stack?: unknown }).stack)
					: here(),
			),
		uncaught: (error) => uncaught(error),
	};
}
