/** what an id may look like: a path segment that needs no encoding */
export declare const ID_PATTERN: RegExp;
/** the id the host gave, checked, or a fresh random one */
export declare function controllerId(id?: string): string;
