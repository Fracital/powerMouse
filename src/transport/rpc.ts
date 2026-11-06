// Minimal promise-based RPC over any postMessage-style channel.
// Adapted from scramjet's @mercuryworkshop/rpc (workspace package, not on npm).

export type RpcDescription = {
	[method: string]: [args: any, returnType: any] | [args: any] | [];
};

export type MethodsDefinition<Description extends RpcDescription> = {
	[Method in keyof Description]: (
		...args: Description[Method] extends [infer A, ...any[]] ? [A] : []
	) => Description[Method] extends [any, infer R]
		? Promise<[R, Transferable[]]>
		: Promise<void>;
};

export type SendRaw = (data: any, transfer: Transferable[]) => void;

export class RpcHelper<
	Local extends RpcDescription,
	Remote extends RpcDescription,
> {
	private counter = 0;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (reason?: unknown) => void }
	>();
	constructor(
		private methods: MethodsDefinition<Local>,
		private id: string,
		private sendRaw: SendRaw,
	) {}
	receive(data: unknown) {
		if (typeof data !== 'object' || data === null) return;
		const dt = (data as Record<string, any>)[this.id];
		if (typeof dt !== 'object' || dt === null) return;

		if (dt.$type === 'response') {
			const cb = this.pending.get(dt.$token);
			if (!cb) return;
			this.pending.delete(dt.$token);
			if (dt.$error !== undefined) cb.reject(new Error(dt.$error));
			else cb.resolve(dt.$data);
		} else if (dt.$type === 'request') {
			const method = dt.$method as keyof Local;
			const handler = this.methods[method] as unknown as
				| ((args: unknown) => Promise<[unknown, Transferable[]] | void>)
				| undefined;

			Promise.resolve()
				.then(() => {
					if (!handler) throw new Error(`Unknown RPC method ${String(method)}`);
					return handler(dt.$args);
				})
				.then((r) => {
					this.sendRaw(
						{
							[this.id]: {
								$type: 'response',
								$token: dt.$token,
								$data: r ? r[0] : undefined,
							},
						},
						r ? r[1] : [],
					);
				})
				.catch((err) => {
					this.sendRaw(
						{
							[this.id]: {
								$type: 'response',
								$token: dt.$token,
								$error: err instanceof Error ? err.message : String(err),
							},
						},
						[],
					);
				});
		}
	}
	call<Method extends keyof Remote>(
		method: Method,
		args: Remote[Method][0],
		transfer: Transferable[] = [],
	): Promise<Remote[Method][1]> {
		const token = this.counter++;
		return new Promise((resolve, reject) => {
			this.pending.set(token, { resolve, reject });
			this.sendRaw(
				{
					[this.id]: {
						$type: 'request',
						$method: method,
						$args: args,
						$token: token,
					},
				},
				transfer,
			);
		});
	}
	/** Reject every outstanding call; used when the underlying port dies. */
	abort(reason: string) {
		for (const { reject } of this.pending.values()) reject(new Error(reason));
		this.pending.clear();
	}
}
