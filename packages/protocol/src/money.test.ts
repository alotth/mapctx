import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "./canonical";
import { moneySchema } from "./money";
import {
  centsToMinorUnits,
  formatMoney,
  microsToMinorUnits,
  minorUnitsToDecimalString,
  parseMoneyAmount
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
