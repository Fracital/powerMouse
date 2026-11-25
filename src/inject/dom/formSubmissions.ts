// A form's submission as the NavigationHint module judges it and tells the
// worker of it (./modules/NavigationHint.ts), a deferred part of the
// document bundle (./deferredParts.ts) made at a document's first
// submission: most documents of a page submit no form, and its frames
// fewer, so the 1.1 KB are in no document until one does.
import type { NavigationHintMessage } from '../../transport/messages';
import { withQuery } from '../../urlShape';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import { baseTarget } from './links';
import { nativeElement } from './modules/DOMHooks';
import { hookWrite } from './modules/MutationObserver';

/** how the module tells the worker of a navigation (NavigationHintModule hint) */
export type SendHint = (
	url: string,
	allow?: string,
	csp?: NavigationHintMessage['csp'],
	opens?: true | [string | null, boolean],
) => void;

/**
 * A form's submission is about to be made: the worker is told where it
 * goes (`send`), and the page's form-action judges it (src/csp.ts). One it
 * refuses goes to a refusal URL (its element's action, put back in a
 * moment): the browser refuses it there and reports it as natively,
 * nothing is sent and no window opens. The action is put back in the next
 * task (a submit event's submission reads it once the event is done), or
 * by the returned function (at the end of submit()). `event`: the submit
 * event, which the page may still cancel
 */
export function formSubmitted(
	client: DocumentClient,
	send: SendHint,
	form: HTMLFormElement,
	submitter: HTMLButtonElement | HTMLInputElement | null,
	event?: Event,
): (() => void) | null {
	const global = client.global;
	const own = (name: string) => !!submitter?.hasAttribute(name);
	const action = own('formaction') ? submitter!.formAction : form.action;
	const method = (
		(own('formmethod') ? submitter!.formMethod : form.method) || 'get'
	).toLowerCase();
	if (method === 'dialog') return null;
	// a javascript: action, judged as its submission starts
	// (DocumentClient jsStarts)
	client.jsStarts(
		(own('formtarget')
			? submitter!.getAttribute('formtarget')
			: form.getAttribute('target')) || baseTarget(global.document),
		action,
		event,
		own('formaction') ? submitter! : form,
	);
	try {
		let url = new URL(action);
		// a form without fields submits to `action?` (src/urlShape.ts)
		if (method === 'get')
			url = withQuery(
				url,
				`?${new URLSearchParams(
					new global.FormData(
						form,
						submitter ?? undefined,
					) as unknown as Record<string, string>,
				).toString()}`,
			);
		if (!/^https?:$/.test(url.protocol)) return null;
		const target = own('formtarget')
			? submitter!.getAttribute('formtarget')
			: form.getAttribute('target');
		const policies = client.hopPolicies('form-action');
		// where the page's code submitted it, which a violation of it
		// names, a redirect's too (a new window's navigation names
		// none, as natively)
		if (policies)
			try {
				deferred('noteFormSite')(client, url.href, target);
			} catch (error) {
				// the part cannot be had: the violation names no place
			}
		if (
			policies &&
			client
				.pageRefusals('form-action', url)
				.some(({ policy }) => policy.disposition === 'enforce')
		) {
			const element: Element = own('formaction') ? submitter! : form;
			const name = element === form ? 'action' : 'formaction';
			const written = nativeElement.getAttribute.call(element, name);
			const refusal = client.refusalURL(
				'https',
				url.href,
				url.href.replace(/#.*$/s, ''),
			);
			const write = (value: string | null) =>
				hookWrite(
					element,
					() => [name],
					() =>
						value === null
							? nativeElement.removeAttribute.call(element, name)
							: nativeElement.setAttribute.call(element, name, value),
				);
			write(refusal);
			const restore = () => {
				if (nativeElement.getAttribute.call(element, name) === refusal)
					write(written);
			};
			Reflect.apply(setTimeout, global, [restore, 0]);
			return restore;
		}
		// (a report-only one's refusal is reported a task later, as the
		// browser would, unless the page cancelled the submission)
		if (policies)
			Reflect.apply(setTimeout, global, [
				() => {
					if (!event?.defaultPrevented)
						client.reportRefusal('form-action', url);
				},
				0,
			]);
		send(url.href, undefined, policies ? { policies } : undefined, [
			target,
			false,
		]);
	} catch (error) {
		// an action that is no URL submits nowhere
	}
	return null;
}
