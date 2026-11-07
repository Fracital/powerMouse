export declare function validCodecURI(uri: string): boolean;
export declare function encodeCodecURI(input: string): string;
export declare function decodeCodecURI(uri: string): string;
export default class GenericCodec {
    key: string;
    constructor(key: string);
    static generateKey(): string;
    encode(input: string): string;
    decode(input: string): string;
}
export declare class XORCodec extends GenericCodec {
    get frequency(): number;
    get xor(): number;
    static generateKey(): string;
    encode(input: string): string;
    decode(input: string): string;
}
export declare class AESCodec extends GenericCodec {
    static generateKey(): string;
    encode(input: string): string;
    decode(input: string): string;
}
export declare class Base64Codec {
    key: string;
    constructor(key: string);
    static generateKey(): string;
    encode(input: string): string;
    decode(input: string): string;
}
