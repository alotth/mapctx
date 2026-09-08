import { z } from "zod";

/**
 * Money value type (T-070 decision D1, crypto-style value pattern): integer
 * minor units + `decimals` + ISO-4217 currency code. Never a float.
 *
 * `{ amountMinor: 200000000, currency: "USD", decimals: 6 }` renders as
 * "200.000000 USD". USD is the working default for amounts (plans, provider
 * pricing, budgets); other currencies are stored natively when they appear.
 * Cross-currency rollup is rare, manual, and explicit: the conversion rate +
 * date are recorded as data at that moment -- no FX service, no automatic
 * conversion, no silent normalization.
 */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "expected an ISO-4217 alpha-3 currency code (e.g. USD)");

export const moneyDecimalsSchema = z.number().int().min(0).max(18);

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export const moneySchema = z.object({
  amountMinor: z
    .number()
    .int()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  currency: currencyCodeSchema,
  decimals: moneyDecimalsSchema
});
export type Money = z.infer<typeof moneySchema>;

export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_DECIMALS = 2;

/** Renders Money deterministically (no locale): "-12.500000 USD"; decimals=0 renders "200 JPY". */
export function formatMoney(money: Money): string {
  const magnitude = minorUnitsToDecimalString(money.amountMinor, money.decimals);
  return `${magnitude} ${money.currency}`;
}

/**
 * Parses a strict decimal string ("200", "200.5", "-200.00") into Money with
 * exactly `decimals` fractional digits. Throws instead of rounding: money
 * that cannot be represented exactly at the requested precision is a caller
 * bug, not a rounding opportunity.
 */
export function parseMoneyAmount(text: string, currency: string, decimals: number): Money {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`decimals must be an integer in [0, 18], got: ${decimals}`);
  }
  if (!currencyCodeSchema.safeParse(currency).success) {
    throw new Error(`currency must be an ISO-4217 alpha-3 code, got: ${currency}`);
  }
  const match = text.trim().match(/^-?\d+(?:\.\d+)?$/);
  if (!match) {
    throw new Error(`amount must be a plain decimal number, got: ${text}`);
  }
  const negative = text.trim().startsWith("-");
  const unsigned = text.trim().replace(/^-/, "");
  const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
  if (fractionRaw.length > decimals) {
    throw new Error(
      `amount ${text} carries more precision than ${decimals} decimal(s) allow; exact representation required`
    );
  }
  const whole = BigInt(wholeRaw);
  const fraction = BigInt(fractionRaw.padEnd(decimals, "0") || "0");
  const amountMinorBig = whole * 10n ** BigInt(decimals) + fraction;
  if (amountMinorBig > MAX_SAFE_MINOR) {
    throw new Error(
      `amount ${text} minor units exceed the safe-integer range (>${Number.MAX_SAFE_INTEGER}); exact representation required`
    );
  }
  const amountMinor = Number(amountMinorBig);
  const parsed = moneySchema.parse({
    amountMinor: negative ? -amountMinor : amountMinor,
    currency,
    decimals
  });
  return parsed;
}

/** Money -> plain decimal string with exactly `decimals` digits ("200.000000", "200" at 0 decimals). */
export function minorUnitsToDecimalString(amountMinor: number, decimals: number): string {
  const negative = amountMinor < 0;
  const abs = BigInt(Math.abs(amountMinor));
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  if (decimals === 0) return `${negative ? "-" : ""}${whole}`;
  const fraction = (abs % divisor).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Exact integer conversion from USD cents (CostEvent.cashCents' unit) into
 * minor units of a `decimals`-precision currency. Throws on lossy conversion:
 * sums that cannot land exactly on the budget's grid must surface loudly,
 * never silently rounded.
 */
export function centsToMinorUnits(cents: number, decimals: number): number {
  assertConvertible(cents, "cents");
  if (decimals >= 2) return scaleChecked(cents, 10n ** BigInt(decimals - 2), "cents");
  const collapse = 10 ** (2 - decimals);
  if (cents % collapse !== 0) {
    throw new Error(`cannot convert ${cents} cents to ${decimals}-decimal minor units without loss`);
  }
  return cents / collapse;
}

/**
 * Exact integer conversion from USD micros (CostEvent shadow/allocated unit,
 * 6 decimals) into minor units of a `decimals`-precision currency. Throws on
 * lossy conversion for the same reason centsToMinorUnits does.
 */
export function microsToMinorUnits(micros: number, decimals: number): number {
  assertConvertible(micros, "micros");
  if (decimals >= 6) return scaleChecked(micros, 10n ** BigInt(decimals - 6), "micros");
  const collapse = 10 ** (6 - decimals);
  if (micros % collapse !== 0) {
    throw new Error(`cannot convert ${micros} micros to ${decimals}-decimal minor units without loss`);
  }
  return micros / collapse;
}

/**
 * Exact integer scaling (grid conversion between decimal precisions, e.g.
 * cents -> micros, or a planned budget onto a finer rollup grid). Throws when
 * the scaled result leaves the safe-integer range: a silently rounded amount
 * would corrupt every downstream sum, so the conversion surfaces loudly.
 * R7 guard: sums and intermediate grid conversions get the same protection.
 */
export function scaleMinorUnits(amountMinor: number, factor: number): number {
  if (!Number.isInteger(factor)) {
    throw new Error(`scale factor must be an integer, got: ${factor}`);
  }
  return scaleChecked(amountMinor, BigInt(factor), "amount");
}

/**
 * Exact integer sum of minor-unit amounts (budget rollup accumulation).
 * Throws when the total leaves the safe-integer range: a silently wrapped
 * or rounded aggregate would corrupt remaining/spent reporting.
 */
export function addMinorUnits(...amounts: number[]): number {
  let total = 0n;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`summand must be a safe integer, got: ${amount}`);
    }
    total += BigInt(amount);
    const abs = total < 0n ? -total : total;
    if (abs > MAX_SAFE_MINOR) {
      throw new Error(`aggregate sum exceeds the safe-integer range; refusing silently-wrapped money`);
    }
  }
  return Number(total);
}

function scaleChecked(amount: number, factor: bigint, unit: string): number {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${unit} must be a safe integer, got: ${amount}`);
  }
  const scaled = BigInt(amount) * factor;
  const abs = scaled < 0n ? -scaled : scaled;
  if (abs > MAX_SAFE_MINOR) {
    throw new Error(
      `${unit} ${amount} scaled by ${factor} exceeds the safe-integer range; refusing silently-rounded money`
    );
  }
  return Number(scaled);
}

function assertConvertible(value: number, unit: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${unit} must already be an integer, got: ${value}`);
  }
}
