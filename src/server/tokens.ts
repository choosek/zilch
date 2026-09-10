/**
 * The confidential-token configuration.
 *
 * zilch conceals the amount with a Zama ERC-7984 confidential token and, to stay
 * contract-free, drives one Zama has already deployed on Sepolia — by default the
 * official cUSDC wrapper over a mock USDC whose `mint` is public, so a fresh
 * wallet can fund itself. This module only *names* that pairing; the browser does
 * the token operations directly with Zama's v3 SDK (shield, confidential
 * transfer, decrypt), so no ABIs or calldata live here.
 *
 * The token and its underlying are overridable by environment variable to point
 * at any ERC-7984 wrapper that follows the same interface.
 */

import type { TokenPair } from "../shared/types.js";

/** Zama's official Sepolia cUSDC wrapper and its public-mint mock USDC. */
const DEFAULT_CTOKEN =
  process.env.ZILCH_CTOKEN ?? "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const DEFAULT_UNDERLYING =
  process.env.ZILCH_UNDERLYING ?? "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const DEFAULT_SYMBOL = process.env.ZILCH_TOKEN_SYMBOL ?? "cUSDC";
const DEFAULT_UNDERLYING_SYMBOL = process.env.ZILCH_UNDERLYING_SYMBOL ?? "USDC";
const DEFAULT_DECIMALS = Number(process.env.ZILCH_TOKEN_DECIMALS ?? "6");

/** The single confidential-token pairing the template ships with. Returned as a
 *  list so the shape generalises to a registry-driven set later. */
export function listTokens(): { registry: string; tokens: TokenPair[] } {
  return {
    registry: "none (direct token)",
    tokens: [
      {
        symbol: DEFAULT_SYMBOL,
        confidentialToken: DEFAULT_CTOKEN,
        underlying: DEFAULT_UNDERLYING,
        underlyingSymbol: DEFAULT_UNDERLYING_SYMBOL,
        decimals: DEFAULT_DECIMALS,
        hasFaucet: true,
      },
    ],
  };
}
