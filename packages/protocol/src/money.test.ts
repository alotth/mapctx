import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "./canonical";
import { moneySchema } from "./money";
import {
  addMinorUnits,
  centsToMinorUnits,
  formatMoney,
  microsToMinorUnits,
  minorUnitsToDecimalString,
  parseMoneyAmount,
  scaleMinorUnits
} from "./money";

test("money serializes round-trip through canonical JSON", () => {
  const money = { amountMinor: 200_000_000, currency: "USD", decimals: 6 };
  const json = canonicalJson(money);
  const parsed = moneySchema.parse(JSON.parse(json));
  assert.deepEqual(parsed, money);
  assert.equal(canonicalJson(parsed), json);
});

test("the decision example renders 200.000000 USD", () => {
  assert.equal(formatMoney({ amountMinor: 200_000_000, currency: "USD", decimals: 6 }), "200.000000 USD");
  assert.equal(formatMoney({ amountMinor: 20_000, currency: "USD", decimals: 2 }), "200.00 USD");
  assert.equal(formatMoney({ amountMinor: -12_500_000, currency: "USD", decimals: 6 }), "-12.500000 USD");
  assert.equal(formatMoney({ amountMinor: 200, currency: "JPY", decimals: 0 }), "200 JPY");
});

test("parseMoneyAmount round-trips with formatMoney", () => {
  for (const text of ["200", "200.5", "200.00", "-12.5", "0", "0.000001"]) {
    const decimals = text.includes(".") ? (text.split(".")[1]?.length ?? 0) : 0;
    const money = parseMoneyAmount(text, "USD", Math.max(decimals, 2));
    const [amount] = text.split(" ");
    assert.equal(
      formatMoney(money),
      `${Number(amount).toFixed(money.decimals)} USD`,
      `round-trip failed for ${text}`
    );
  }
  const money = parseMoneyAmount("200.00", "USD", 2);
  assert.deepEqual(money, { amountMinor: 20_000, currency: "USD", decimals: 2 });
});

test("parseMoneyAmount rejects precision loss, junk, and bad currency", () => {
  assert.throws(() => parseMoneyAmount("200.0000001", "USD", 6), /more precision/);
  assert.throws(() => parseMoneyAmount("200.00", "USD", 1), /more precision/);
  assert.throws(() => parseMoneyAmount("1e6", "USD", 2), /plain decimal/);
  assert.throws(() => parseMoneyAmount("abc", "USD", 2), /plain decimal/);
  assert.throws(() => parseMoneyAmount("10", "usd", 2), /ISO-4217/);
  assert.throws(() => parseMoneyAmount("10", "DOLLARS", 2), /ISO-4217/);
  assert.throws(() => parseMoneyAmount("10", "USD", 2.5), /decimals/);
});

test("minorUnitsToDecimalString is exact at every decimals width", () => {
  assert.equal(minorUnitsToDecimalString(200_000_000, 6), "200.000000");
  assert.equal(minorUnitsToDecimalString(1, 6), "0.000001");
  assert.equal(minorUnitsToDecimalString(-1, 2), "-0.01");
  assert.equal(minorUnitsToDecimalString(200, 0), "200");
});

test("cents and micros convert exactly into minor units, and refuse lossy grids", () => {
  assert.equal(centsToMinorUnits(20_000, 2), 20_000);
  assert.equal(centsToMinorUnits(20_000, 6), 200_000_000);
  assert.equal(microsToMinorUnits(80_000, 6), 80_000);
  assert.equal(microsToMinorUnits(80_000, 2), 8);
  assert.throws(() => microsToMinorUnits(80_000, 0), /without loss/);
  assert.throws(() => microsToMinorUnits(80_001, 2), /without loss/);
  assert.throws(() => centsToMinorUnits(1, 0), /without loss/);
  assert.throws(() => centsToMinorUnits(1.5, 2), /must already be an integer/);
  assert.throws(() => microsToMinorUnits(-3, 3), /without loss/);
});

// R7: money arithmetic must be exact or refusing -- never silently rounded.
test("R7: parseMoneyAmount rejects values outside the safe-integer range exactly", () => {
  // 2^53 + 1 rounds to 9007199254740992 as a Number; the parser must refuse
  // on magnitude rather than accept the rounded value.
  assert.throws(() => parseMoneyAmount("9007199254740993", "USD", 0), /safe-integer range/);
  // Exact last minor unit at 18 decimals would vanish through a Number path.
  assert.throws(() => parseMoneyAmount("1.000000000000000001", "USD", 18), /safe-integer range/);
  // Boundary: the largest safe minor amount still parses and renders exactly.
  assert.equal(parseMoneyAmount("9007199254740991", "USD", 0).amountMinor, 9007199254740991);
  assert.equal(
    formatMoney(parseMoneyAmount("1.000000", "USD", 6)),
    "1.000000 USD"
  );
  assert.throws(() => moneySchema.parse({ amountMinor: 9007199254740993, currency: "USD", decimals: 0 }));
});

test("R7: minorUnitsToDecimalString stays exact without float division", () => {
  const max = 9007199254740991;
  assert.equal(minorUnitsToDecimalString(max, 6), "9007199254.740991");
  assert.equal(minorUnitsToDecimalString(-max, 6), "-9007199254.740991");
  assert.equal(minorUnitsToDecimalString(max, 0), "9007199254740991");
});

test("R7: grid conversions refuse results beyond the safe-integer range", () => {
  assert.throws(() => centsToMinorUnits(9007199254740991, 6), /safe-integer range/);
  assert.throws(() => microsToMinorUnits(9007199254740991, 18), /safe-integer range/);
  assert.equal(centsToMinorUnits(9007199254740991, 2), 9007199254740991);
});

test("R7: scaling and sums throw before a rounded/wrapped amount persists", () => {
  assert.throws(() => scaleMinorUnits(9007199254740991, 1_000_000), /safe-integer range/);
  assert.equal(scaleMinorUnits(9007199254740991, 1), 9007199254740991);
  assert.throws(() => addMinorUnits(9007199254740991, 2), /safe-integer range/);
  assert.equal(addMinorUnits(9007199254740991, -9007199254740991), 0);
  assert.equal(addMinorUnits(200_000_000, 80_000), 200_080_000);
  // Equal-value mixed-decimal amounts: 2.00 USD (200 cents-grid) vs 2.000000.
  assert.equal(
    addMinorUnits(centsToMinorUnits(200, 6), microsToMinorUnits(2_000_000, 6)),
    4_000_000
  );
});
