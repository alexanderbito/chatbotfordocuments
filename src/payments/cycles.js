/**
 * Billing cycles.
 *
 * One module owns the answer to "what does this plan cost on this cycle and
 * how long does that buy", because that answer is used in four places — the
 * public price list, the checkout, the invoice and the system-admin screens —
 * and they must never disagree. If the pricing page says $187 and the checkout
 * charges $228, the customer is right and we are wrong, whatever the code says.
 *
 * The prices themselves live in the plans table. Nothing here invents one.
 */

export const CYCLES = ['monthly', 'yearly'];

/** Months a cycle buys. The database repeats this in activate_paid_plan. */
export const MONTHS = { monthly: 1, yearly: 12 };

/**
 * Coerce whatever the browser sent into a cycle we sell.
 *
 * Anything unrecognised becomes 'monthly' rather than an error: the cycle only
 * ever picks between two prices that are both ours, so the worst a bad value
 * can do is charge the smaller one. Throwing here would turn a stale browser
 * tab into a failed checkout.
 */
export function normalizeCycle(value) {
  return CYCLES.includes(value) ? value : 'monthly';
}

/**
 * The price of a plan on a cycle, as a number, straight from the plan row.
 * Returns 0 when the plan is not sold on that cycle — callers treat 0 as
 * "not for sale" rather than "free".
 */
export function priceFor(plan, cycle) {
  if (!plan) return 0;
  return normalizeCycle(cycle) === 'yearly'
    ? Number(plan.price_usd_yearly || 0)
    : Number(plan.price_usd || 0);
}

export function monthsFor(cycle) {
  return MONTHS[normalizeCycle(cycle)];
}

/**
 * Add the fields the interface needs to talk about the yearly option, so no
 * page has to work out a percentage for itself.
 *
 * `yearly_saving_pct` is computed from the two stored prices rather than from
 * the 18% the prices were originally seeded with. If a system admin edits one
 * price, the badge follows the real number instead of continuing to advertise
 * a discount that is no longer being given.
 */
export function decoratePlan(plan) {
  const monthly = Number(plan.price_usd || 0);
  const yearly = Number(plan.price_usd_yearly || 0);
  const sellsYearly = monthly > 0 && yearly > 0;

  return {
    ...plan,
    price: monthly,                  // kept for older callers
    price_monthly: monthly,
    price_yearly: yearly,
    has_yearly: sellsYearly,
    // What a year costs broken down per month — the number customers actually
    // compare against the monthly price. Two decimals, because $15.58 rounded
    // to $16 would make the yearly option look worse than it is.
    yearly_per_month: sellsYearly ? Math.round((yearly / 12) * 100) / 100 : 0,
    yearly_saving: sellsYearly ? Math.round((monthly * 12 - yearly) * 100) / 100 : 0,
    yearly_saving_pct: sellsYearly ? Math.round((1 - yearly / (monthly * 12)) * 100) : 0,
  };
}
