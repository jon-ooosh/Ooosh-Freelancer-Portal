jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../hirehop-broker', () => ({ hhBroker: {} }));

import { vanTypeFromStockTitle } from '../hh-van-stock';

describe('vanTypeFromStockTitle', () => {
  it.each([
    ['Premium LWB Splitter Van - auto gearbox', 'Premium', 'auto'],
    ['Premium LWB Splitter Van - manual gearbox', 'Premium', 'manual'],
    ['Standard MWB Splitter Van - auto gearbox', 'Standard', 'auto'],
    ['Standard MWB Splitter Van - manual gearbox', 'Standard', 'manual'],
    ['Basic MWB Splitter Van - manual gearbox', 'Basic', 'manual'],
    ['Mercedes Vito 114 LWB 6-seater mini-splitter - auto gearbox', 'Vito', 'auto'],
    ['Panel Van (Mercedes Sprinter)', 'Panel', null],
    ['Ford eTransit Panel Van', 'Panel', null],
  ])('%s', (title, type, gearbox) => {
    expect(vanTypeFromStockTitle(title)).toEqual({ simpleType: type, gearbox });
  });
});
