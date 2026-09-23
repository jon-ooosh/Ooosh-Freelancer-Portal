/**
 * VAT resolution for shop sales. Money, and a trap, so pinned down.
 *
 * `VAT_RATE` on a HireHop consumables row is an INDEX INTO HIREHOP'S TAX TYPES,
 * not a percentage. The verified item (1" green fluoro tape, scratch job 16735,
 * Sep 2026) returned `VAT_RATE: 0` while the HireHop UI displayed "Tax rate
 * Standard". Anything that reads that 0 as "0% VAT" charges no VAT on every
 * item in the shop and under-declares the weekly invoice.
 *
 * So the behaviour that matters is the FALLBACK DIRECTION: an unknown, missing
 * or unreadable rate must land on the standard rate, never on zero.
 * Over-charging VAT is a correctable error; under-declaring it is not.
 *
 * Every test loads a fresh copy of the module, because the service caches the
 * rate map for five minutes and a cache shared across tests would hide exactly
 * the fallback behaviour these assert.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

type ShopStock = typeof import('../shop-stock');

/**
 * A fresh module registry, plus the `query` mock THAT copy actually uses.
 * Re-importing the mock matters: after `resetModules` the module under test
 * binds to a new mock instance, so a handle kept from an earlier import
 * silently configures the wrong one.
 */
async function freshModule(settingValue: string | null | Error): Promise<ShopStock> {
  jest.resetModules();
  const db = await import('../../config/database');
  const q = db.query as jest.Mock;
  if (settingValue instanceof Error) {
    q.mockRejectedValue(settingValue);
  } else {
    q.mockResolvedValue({ rows: settingValue === null ? [] : [{ value: settingValue }] });
  }
  return import('../shop-stock');
}

/** No `shop_vat_rate_map` row configured — the out-of-the-box state. */
const unconfigured = () => freshModule(null);

describe('resolveVatRate', () => {
  it('treats index 0 as the STANDARD rate, not zero-rated', async () => {
    const m = await unconfigured();
    // The whole point: HireHop's 0 means "standard", and the shop's most common
    // items return exactly that.
    await expect(m.resolveVatRate(0)).resolves.toBe(20);
  });

  it('falls back to standard for an index nobody has mapped', async () => {
    const m = await unconfigured();
    await expect(m.resolveVatRate(7)).resolves.toBe(20);
  });

  it('falls back to standard when the rate is missing entirely', async () => {
    const m = await unconfigured();
    await expect(m.resolveVatRate(null)).resolves.toBe(20);
    await expect(m.resolveVatRate(undefined)).resolves.toBe(20);
  });

  it('honours a configured map — a genuinely zero-rated index can exist', async () => {
    // Cold food is zero-rated in the UK while canned drinks and confectionery
    // are standard, so a shop selling snacks may legitimately need a second index.
    const m = await freshModule(JSON.stringify({ '0': 20, '1': 0 }));
    await expect(m.resolveVatRate(1)).resolves.toBe(0);
    await expect(m.resolveVatRate(0)).resolves.toBe(20);
  });

  it('ignores a malformed setting rather than silently zero-rating the shop', async () => {
    const m = await freshModule('not json at all');
    await expect(m.resolveVatRate(0)).resolves.toBe(20);
  });

  it('ignores out-of-range percentages in the setting', async () => {
    const m = await freshModule(JSON.stringify({ '0': 900 }));
    await expect(m.resolveVatRate(0)).resolves.toBe(20);
  });

  it('ignores a setting that is a JSON array rather than a map', async () => {
    const m = await freshModule(JSON.stringify([20, 0]));
    await expect(m.resolveVatRate(0)).resolves.toBe(20);
  });

  it('survives the settings table being unreadable', async () => {
    const m = await freshModule(new Error('db down'));
    await expect(m.resolveVatRate(0)).resolves.toBe(20);
  });
});

describe('grossPrice', () => {
  it('adds VAT to an ex-VAT HireHop price', async () => {
    const m = await unconfigured();
    // £7.50 ex-VAT is what HireHop holds for the green fluoro tape; £9.00 is
    // what the customer actually hands over.
    await expect(m.grossPrice(7.5, 0)).resolves.toBe(9);
  });

  it('rounds to the penny rather than leaving float dust', async () => {
    const m = await unconfigured();
    await expect(m.grossPrice(4.16, 0)).resolves.toBe(4.99);
    await expect(m.grossPrice(13.75, 0)).resolves.toBe(16.5);
  });

  it('leaves a zero-rated line alone', async () => {
    const m = await freshModule(JSON.stringify({ '0': 20, '1': 0 }));
    await expect(m.grossPrice(1.2, 1)).resolves.toBe(1.2);
  });
});

/**
 * Category exclusions hide non-shop sale stock from the till — HireHop's 974
 * sale items include things like VE103B certificates, which are a compliance
 * charge raised onto a hire, not something a walk-in buys.
 *
 * The direction that matters here is the opposite of the VAT one: this must
 * fail OPEN. Hiding an item nobody classified means staff cannot complete a
 * sale with the customer standing there, which is worse than briefly listing
 * something that shouldn't be sold over the counter.
 */
describe('getExcludedCategoryIds', () => {
  it('reads the configured list', async () => {
    const m = await freshModule(JSON.stringify([355]));
    await expect(m.getExcludedCategoryIds()).resolves.toEqual([355]);
  });

  it('hides nothing when the setting is absent', async () => {
    const m = await freshModule(null);
    await expect(m.getExcludedCategoryIds()).resolves.toEqual([]);
  });

  it('hides nothing when the setting is malformed', async () => {
    const m = await freshModule('{"not":"an array"}');
    await expect(m.getExcludedCategoryIds()).resolves.toEqual([]);
  });

  it('hides nothing when the settings table is unreadable', async () => {
    const m = await freshModule(new Error('db down'));
    await expect(m.getExcludedCategoryIds()).resolves.toEqual([]);
  });

  it('drops non-numeric entries rather than rejecting the whole list', async () => {
    const m = await freshModule(JSON.stringify([355, 'oops', 356]));
    await expect(m.getExcludedCategoryIds()).resolves.toEqual([355, 356]);
  });
});
