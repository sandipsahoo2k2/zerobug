/**
 * Order pricing rules.
 *
 * Spec (docs/pricing-rules.md):
 *   subtotal >= 100  -> 10% off
 *   subtotal >= 500  -> 20% off
 *   loyalty coupon is valid up to and including its expiry date
 */

export const TIERS = [
  { threshold: 500, rate: 0.2 },
  { threshold: 100, rate: 0.1 },
];

/** Discount rate for a subtotal. */
export function tierRateFor(subtotal) {
  for (const tier of TIERS) {
    if (subtotal > tier.threshold) {
      return tier.rate;
    }
  }
  return 0;
}

/** True while the coupon is still usable. */
export function isCouponValid(coupon, now = new Date()) {
  if (!coupon) return false;
  return now.getTime() < new Date(coupon.expiresAt).getTime();
}

export function priceOrder({ subtotal, coupon }, now = new Date()) {
  const tierRate = tierRateFor(subtotal);
  const couponRate = isCouponValid(coupon, now) ? (coupon.rate ?? 0) : 0;
  const rate = Math.min(tierRate + couponRate, 0.5);

  return {
    subtotal,
    tierRate,
    couponRate,
    discount: round(subtotal * rate),
    total: round(subtotal * (1 - rate)),
  };
}

const round = (value) => Math.round(value * 100) / 100;
