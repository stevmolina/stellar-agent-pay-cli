// Stellar USDC uses 7 decimal places (not 6 like EVM USDC).
const USDC_DECIMALS = 7;

/**
 * Convert a human amount ("$0.01", "0.01", 0.01) to 7-decimal USDC base units.
 */
export function usdToBaseUnits(usd: string | number): bigint {
  const raw = typeof usd === "string" ? usd.trim().replace(/^\$/, "") : String(usd);
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid USD amount: "${usd}"`);
  }
  const [whole, frac = ""] = raw.split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
}

/**
 * Format 7-decimal USDC base units back to a human "$X.YYYYYYY" string, trimming trailing zeros.
 */
export function baseUnitsToUsd(baseUnits: string | bigint | number): string {
  const n = BigInt(baseUnits);
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = n / divisor;
  const frac = (n % divisor).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `$${whole.toString()}${frac ? "." + frac : ""}`;
}
