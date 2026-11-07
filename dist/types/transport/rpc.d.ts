export type RpcDescription = {
    [method: string]: [args: any, returnType: any] | [args: any] | [];
};
export type MethodsDefinition<Description extends RpcDescription> = {
    [Method in keyof Description]: (...args: Description[Method] extends [infer A, ...any[]] ? [A] : []) => Description[Method] extends [any, infer R] ? Promise<[R, Transferable[]]> : Promise<void>;
};
export type SendRaw = (data: any, transfer: Transferable[]) => void;
export declare class RpcHelper<Local extends RpcDescription, Remote extends RpcDescription> {
    private methods;
    private id;
    private sendRaw;
    private counter;
    private pending;
    /** set by abort(): the channel is dead and every later call fails with this at once */
    private aborted?;
    constructor(methods: MethodsDefinition<Local>, id: string, sendRaw: SendRaw);
    receive(data: unknown): void;
    call<Method extends keyof Remote>(method: Method, args: Remote[Method][0], transfer?: Transferable[]): Promise<Remote[Method][1]>;
    /**
     * Reject every outstanding call, and every later one at once; used when
     * the underlying port dies (a closed port swallows messages silently, so a
     * call on it would otherwise wait forever).
     */
    abort(reason: string): void;
}
