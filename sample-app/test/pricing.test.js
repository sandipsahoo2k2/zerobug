import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCouponValid, priceOrder, tierRateFor } from '../src/pricing.js';

test('no discount below the first tier', () => {
  assert.equal(tierRateFor(99), 0);
});

test('10% between the first and second tier', () => {
  assert.equal(tierRateFor(250), 0.1);
});

test('20% above the second tier', () => {
  assert.equal(tierRateFor(900), 0.2);
});

test('coupon in the future is valid', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.equal(isCouponValid({ expiresAt: '2026-02-01T00:00:00Z' }, now), true);
});

test('order total applies the tier rate', () => {
  const result = priceOrder({ subtotal: 200 }, new Date('2026-01-01T00:00:00Z'));
  assert.equal(result.total, 180);
});
