import GenericCodec from './Codecs';
export declare type urlLike = URL | string;
export declare function isUrlLike(object: unknown): object is urlLike;
export default class StompURL {
    codec: GenericCodec;
    directory: string;
    url: URL;
    constructor(url: urlLike, reference: StompURL);
    constructor(url: urlLike, codec: GenericCodec, directory: string);
    encode(): string;
    toString(): string;
}
