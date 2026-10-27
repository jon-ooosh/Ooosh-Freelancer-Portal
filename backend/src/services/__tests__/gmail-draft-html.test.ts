jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../../config/gmail', () => ({}));
jest.mock('../chase-draft', () => ({}));
jest.mock('../email-matcher', () => ({}));

import { bodyAsGmailHtml } from '../gmail-draft';

describe('bodyAsGmailHtml', () => {
  it('puts each line in its own div, so Gmail does not hard-wrap it', () => {
    expect(bodyAsGmailHtml('Hi Noah,\nHope you\'re well.\nBest wishes,\nJon'))
      .toBe('<div dir="ltr"><div>Hi Noah,</div><div>Hope you\'re well.</div><div>Best wishes,</div><div>Jon</div></div>');
  });
  it('escapes HTML and keeps a blank line as a break', () => {
    expect(bodyAsGmailHtml('A & <b>B</b>\r\n\r\nC')).toBe('<div dir="ltr"><div>A &amp; &lt;b&gt;B&lt;/b&gt;</div><div><br></div><div>C</div></div>');
  });
});
