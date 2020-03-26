import assert = require("assert");
import Multiaddr = require("multiaddr");
import base64url from "base64url";
import { toBigIntBE } from "bigint-buffer";
import * as RLP from "rlp";

import { ERR_INVALID_ID, ERR_NO_SIGNATURE, MAX_RECORD_SIZE } from "./constants";
import * as v4 from "./v4";
import { ENRKey, ENRValue, SequenceNumber, NodeId } from "./types";
import { createKeypair, KeypairType, IKeypair } from "../keypair";

export class ENR extends Map<ENRKey, ENRValue> {
  public seq: SequenceNumber;
  public signature: Buffer | null;

  constructor(kvs: Record<ENRKey, ENRValue> = {}, seq: SequenceNumber = 1n, signature: Buffer | null = null) {
    super(Object.entries(kvs));
    this.seq = seq;
    this.signature = signature;
  }
  static createV4(publicKey: Buffer, kvs: Record<ENRKey, ENRValue> = {}): ENR {
    return new ENR({
      ...kvs,
      "id": Buffer.from("v4"),
      "secp256k1": publicKey,
    });
  }
  static decode(encoded: Buffer): ENR {
    const decoded = RLP.decode(encoded) as unknown as Buffer[];
    assert(Array.isArray(decoded), "Decoded ENR must be an array");
    assert(decoded.length % 2 === 0, "Decoded ENR must have an even number of elements");
    const [signature, seq, ...kvs] = decoded;
    const obj: Record<ENRKey, ENRValue> = {};
    for (let i = 0; i < kvs.length; i += 2) {
      obj[kvs[i].toString()] = Buffer.from(kvs[i + 1]);
    }
    const enr = new ENR(obj, toBigIntBE(seq), signature);
    assert(
      enr.verify(RLP.encode([seq, ...kvs]), signature),
      "Unable to verify enr signature"
    );
    return enr;
  }
  static decodeTxt(encoded: string): ENR {
    assert(encoded.startsWith("enr:"), "string encoded ENR must start with 'enr:'");
    return ENR.decode(base64url.toBuffer(encoded.slice(4)));
  }
  set(k: ENRKey, v: ENRValue): this {
    this.signature = null;
    this.seq++;
    return super.set(k, v);
  }
  get id(): string {
    return (this.get("id") as Buffer).toString("utf8");
  }
  get keypairType(): KeypairType {
    switch (this.id) {
      case "v4":
        return KeypairType.secp256k1;
      default:
        throw new Error(ERR_INVALID_ID);
    }
  }
  get publicKey(): Buffer {
    switch (this.id) {
      case "v4":
        return this.get("secp256k1") as Buffer;
      default:
        throw new Error(ERR_INVALID_ID);
    }
  }
  get keypair(): IKeypair {
    return createKeypair(this.keypairType, undefined, this.publicKey);
  }
  get nodeId(): NodeId {
    switch (this.id) {
      case "v4":
        return v4.nodeId(this.publicKey);
      default:
        throw new Error(ERR_INVALID_ID);
    }
  }
  get multiaddrUDP(): Multiaddr | undefined {
    // First try IPv4
    const ip4 = this.get("ip");
    if (ip4) {
      const udp4 = this.get("udp");
      if (udp4) {
        return Multiaddr(`/ip4/${Array.from(ip4).join(".")}/udp/${udp4.readUInt16BE(0)}`);
      }
    }
    // Then try IPv6
    const ip6 = this.get("ip6");
    if (ip6) {
      const udp6 = this.get("udp6");
      if (udp6) {
        const ip6Str = Array.from(Uint16Array.from(ip6)).map((n) => n.toString(16)).join(":");
        return Multiaddr(`/ip6/${ip6Str}/udp/${udp6.readUInt16BE(0)}`);
      }
    }
    return undefined;
  }
  set multiaddrUDP(multiaddr: Multiaddr | undefined) {
    if (!multiaddr) {
      return;
    }
    const protoNames = multiaddr.protoNames();
    if (protoNames.length !== 2 && protoNames[1] !== "udp") {
      throw new Error("Invalid udp multiaddr");
    }
    const tuples = multiaddr.tuples();
    // IPv4
    if (tuples[0][0] === 4) {
      this.set("ip", tuples[0][1]);
      this.set("udp", tuples[1][1]);
    } else {
      this.set("ip6", tuples[0][1]);
      this.set("udp6", tuples[1][1]);
    }
  }
  get multiaddrTCP(): Multiaddr | undefined {
    // First try IPv4
    const ip4 = this.get("ip");
    if (ip4) {
      const tcp4 = this.get("tcp");
      if (tcp4) {
        return Multiaddr(`/ip4/${Array.from(ip4).join(".")}/tcp/${tcp4.readUInt16BE(0)}`);
      }
    }
    // Then try IPv6
    const ip6 = this.get("ip6");
    if (ip6) {
      const tcp6 = this.get("tcp6");
      if (tcp6) {
        const ip6Str = Array.from(Uint16Array.from(ip6)).map((n) => n.toString(16)).join(":");
        return Multiaddr(`/ip6/${ip6Str}/tcp/${tcp6.readUInt16BE(0)}`);
      }
    }
    return undefined;
  }
  set multiaddrTCP(multiaddr: Multiaddr | undefined) {
    if (!multiaddr) {
      return;
    }
    const protoNames = multiaddr.protoNames();
    if (protoNames.length !== 2 && protoNames[1] !== "tcp") {
      throw new Error("Invalid udp multiaddr");
    }
    const tuples = multiaddr.tuples();
    // IPv4
    if (tuples[0][0] === 4) {
      this.set("ip", tuples[0][1]);
      this.set("tcp", tuples[1][1]);
    } else {
      this.set("ip6", tuples[0][1]);
      this.set("tcp6", tuples[1][1]);
    }

  }
  verify(data: Buffer, signature: Buffer): boolean {
    switch (this.id) {
      case "v4":
        return v4.verify(this.publicKey, data, signature);
      default:
        throw new Error(ERR_INVALID_ID);
    }
  }
  sign(data: Buffer, privateKey: Buffer): Buffer {
    switch (this.id) {
      case "v4":
        this.signature = v4.sign(privateKey, data);
        break;
      default:
        throw new Error(ERR_INVALID_ID);
    }
    return this.signature;
  }
  encode(privateKey?: Buffer): Buffer {
    // sort keys and flatten into [k, v, k, v, ...]
    const content: Array<ENRKey | ENRValue| number> = Array.from(this.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ([k, this.get(k)] as [ENRKey, ENRValue]))
      .flat();
    content.unshift(Number(this.seq));
    if (privateKey) {
      content.unshift(this.sign(RLP.encode(content), privateKey));
    } else {
      if (!this.signature) {
        throw new Error(ERR_NO_SIGNATURE);
      }
      content.unshift(this.signature);
    }
    const encoded = RLP.encode(content);
    assert(encoded.length < MAX_RECORD_SIZE, "ENR must be less than 300 bytes");
    return encoded;
  }
  encodeTxt(privateKey: Buffer): string {
    return "enr:" + base64url.encode(Buffer.from(this.encode(privateKey)));
  }
}
