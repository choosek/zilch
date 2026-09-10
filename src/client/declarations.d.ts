/**
 * Ambient global types for the browser client.
 *
 * zilch's client depends on two things the page provides rather than the bundle:
 * an injected wallet (discovered via EIP-6963, so MetaMask, Rainbow, and any
 * other conforming wallet all work) and Zama's relayer SDK, loaded from a CDN
 * `<script>` and exposed as `window.relayerSDK`. Declaring their shapes here
 * keeps the client dependency-free — it ships no wallet library and no Zama
 * bundle — while still type-checking every call. This file is ambient (no
 * imports or exports) so the types are visible everywhere without importing.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/** One handle bound to the contract that can decrypt it, for user decryption. */
interface ZamaHandlePair {
  handle: string;
  contractAddress: string;
}

/** The encrypted-input builder: add a value, then prove and encrypt it. The
 *  handles and proof come back as hex strings or byte arrays depending on build;
 *  the client normalises either to `0x`-hex. */
interface ZamaEncryptedInput {
  add64(value: bigint | number): ZamaEncryptedInput;
  encrypt(): Promise<{
    handles: Array<Uint8Array | string>;
    inputProof: Uint8Array | string;
  }>;
}

/** A live Zama instance for one chain, from `createInstance(SepoliaConfig)`. */
interface ZamaInstance {
  createEncryptedInput(contract: string, user: string): ZamaEncryptedInput;
  generateKeypair(): { publicKey: string; privateKey: string };
  createEIP712(
    publicKey: string,
    contractAddresses: string[],
    startTimestamp: number,
    durationDays: number,
  ): {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType: string;
  };
  userDecrypt(
    pairs: ZamaHandlePair[],
    privateKey: string,
    publicKey: string,
    signature: string,
    contractAddresses: string[],
    userAddress: string,
    startTimestamp: number,
    durationDays: number,
  ): Promise<Record<string, string | bigint | boolean>>;
  publicDecrypt(
    handles: string[],
  ): Promise<Record<string, string | bigint | boolean>>;
}

/** The CDN global. `initSDK` loads the WASM; `createInstance` builds an instance
 *  from a network config such as the bundled `SepoliaConfig`. */
interface ZamaRelayerSDK {
  initSDK(options?: unknown): Promise<void>;
  createInstance(config: unknown): Promise<ZamaInstance>;
  SepoliaConfig: unknown;
}

interface Window {
  ethereum?: Eip1193Provider;
  relayerSDK?: ZamaRelayerSDK;
}

interface WindowEventMap {
  "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
}
