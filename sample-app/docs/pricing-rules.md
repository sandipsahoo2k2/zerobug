# Pricing rules

| Subtotal | Discount |
| --- | --- |
| `< 100` | none |
| `>= 100` | 10% |
| `>= 500` | 20% |

Thresholds are **inclusive**: an order of exactly 100.00 gets 10%, an order of exactly
500.00 gets 20%.

Loyalty coupons stack with the tier discount, capped at 50% total. A coupon is valid
**up to and including** the instant in `expiresAt`.
