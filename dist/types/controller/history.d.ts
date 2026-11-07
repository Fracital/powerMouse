export interface NavigationLike {
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    readonly currentEntry: {
        readonly index: number;
    } | null;
    back(): {
        committed: Promise<unknown>;
        finished: Promise<unknown>;
    };
    forward(): {
        committed: Promise<unknown>;
        finished: Promise<unknown>;
    };
}
export type Direction = 'back' | 'forward';
/** whether the frame's own history has an entry in `direction`; null when the browser cannot tell */
export declare function canTraverse(win: Window | null | undefined, direction: Direction): boolean | null;
/**
 * Step the frame's own history. Resolves false when there is nothing to go
 * to, true once the traversal has committed (so a second call computes its
 * target from the entry the first one reached). Without the Navigation API
 * the step is issued blind through history.back(), which the caller should
 * only do when it knows the frame has somewhere to go.
 */
export declare function traverse(win: Window, direction: Direction): Promise<boolean>;
