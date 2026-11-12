import { FORM_QUERY_NAME } from '../../../routeURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';

/**
 * A GET form's fields go after its action's route as the browser writes
 * them, in clear, in the request and in the frame's address. So the entry
 * list of a GET submission, once the page's own formdata listeners have
 * seen it, is replaced by one unnamed entry holding the query sealed
 * (`?=<sealed>`, src/routeURL.ts formQuery): the request names no field, and
 * the worker reads the query out of it. The page's own `new FormData(form)`
 * fires formdata too; that one is the page's and left as it is.
 */
export default class FormQueryModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const codec = this.client.codec;
		const NativeFormData = global.FormData;
		const formDataProto = NativeFormData.prototype;
		const entries = formDataProto.entries;
		const deleteEntry = formDataProto.delete;
		const appendEntry = formDataProto.append;
		const nativeSubmit = global.HTMLFormElement.prototype.submit;
		const getAttribute = global.Element.prototype.getAttribute;
		const hasAttribute = global.Element.prototype.hasAttribute;
		const File = global.File;

		// the page's own FormData objects being made (they fire formdata)
		let making = 0;
		const Wrapped = proxyModule.wrapFunction(
			NativeFormData,
			(target, that, args, newTarget) => {
				if (!newTarget) return Reflect.apply(target, that, args);
				making++;
				try {
					return Reflect.construct(target, args, newTarget);
				} finally {
					making--;
				}
			},
			true,
		);
		const descriptor = Reflect.getOwnPropertyDescriptor(global, 'FormData');
		if (descriptor?.value === NativeFormData)
			Reflect.defineProperty(global, 'FormData', {
				...descriptor,
				value: Wrapped,
			});

		/** the method the submission of `form` by `submitter` uses, as the page set it */
		const methodOf = (
			form: HTMLFormElement,
			submitter: Element | null,
		): string => {
			const own =
				submitter &&
				Reflect.apply(hasAttribute, submitter, ['formmethod']) &&
				Reflect.apply(getAttribute, submitter, ['formmethod']);
			const method = (
				own ||
				Reflect.apply(getAttribute, form, ['method']) ||
				'get'
			).toLowerCase();
			return method === 'post' || method === 'dialog' ? method : 'get';
		};

		// The submission's formdata comes after every page listener of the
		// submit event (one that cancels it has none): the module listens for
		// it from then on, on the window, after the page's own listeners
		let armed: { form: HTMLFormElement; submitter: Element | null } | null =
			null;
		const onFormData = (event: Event) => {
			const form = event.target;
			if (making || !armed || form !== armed.form) return;
			const { submitter } = armed;
			armed = null;
			global.removeEventListener('formdata', onFormData);
			if (methodOf(form as HTMLFormElement, submitter) !== 'get') return;
			const data = (event as FormDataEvent).formData;
			const list = [
				...(Reflect.apply(entries, data, []) as IterableIterator<
					[string, FormDataEntryValue]
				>),
			];
			// the application/x-www-form-urlencoded serializer: a file is its name
			const query = new global.URLSearchParams();
			for (const [name, value] of list)
				query.append(name, value instanceof File ? value.name : value);
			for (const [name] of list) Reflect.apply(deleteEntry, data, [name]);
			Reflect.apply(appendEntry, data, [
				FORM_QUERY_NAME,
				codec.encode(query.toString()),
			]);
		};
		const arm = (form: HTMLFormElement, submitter: Element | null) => {
			armed = { form, submitter };
			global.removeEventListener('formdata', onFormData);
			global.addEventListener('formdata', onFormData);
			// a cancelled submission has no formdata
			const channel = new global.MessageChannel();
			channel.port1.onmessage = () => {
				channel.port1.close();
				if (armed?.form === form) {
					armed = null;
					global.removeEventListener('formdata', onFormData);
				}
			};
			channel.port2.postMessage(null);
		};
		const onSubmit = (event: Event) => {
			if (event.target instanceof global.HTMLFormElement)
				arm(event.target, (event as SubmitEvent).submitter);
		};
		const listen = () => global.addEventListener('submit', onSubmit, true);
		listen();
		addDocumentOpenListener(global, listen);

		// submit() fires no submit event
		global.HTMLFormElement.prototype.submit = proxyModule.wrapFunction(
			nativeSubmit,
			(target, that, args) => {
				if (that instanceof global.HTMLFormElement) arm(that, null);
				return Reflect.apply(target, that, args);
			},
		);
	}
}
