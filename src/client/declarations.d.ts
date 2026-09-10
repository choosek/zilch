/**
 * Ambient global types for the browser client.
 *
 * zilch discovers an injected wallet via EIP-6963, so MetaMask, Rainbow, and any
 * other conforming wallet all work. Declaring the provider shapes here keeps the
 * client from depending on a wallet library. (Zama's SDK is a bundled import, not
 * a global, so it needs no ambient declaration.) This file is ambient — no
 * imports or exports — so the types are visible everywhere.
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

interface Window {
  ethereum?: Eip1193Provider;
}

interface WindowEventMap {
  "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
}
