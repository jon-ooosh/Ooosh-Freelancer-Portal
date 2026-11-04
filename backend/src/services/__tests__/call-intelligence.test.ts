import { channelSpeakers, sentencesToText } from '../call-intelligence';

describe('who is on which channel', () => {
  it('incoming: caller first; outgoing: us first; voicemail: caller only', () => {
    expect(channelSpeakers('inbound', 'call')).toEqual({ 1: 'Caller', 2: 'Ooosh' });
    expect(channelSpeakers('outbound', 'call')).toEqual({ 1: 'Ooosh', 2: 'Them' });
    expect(channelSpeakers('inbound', 'voicemail')).toEqual({ 1: 'Caller' });
  });
});

describe('transcript text', () => {
  it('labels speakers and joins a run of sentences from the same person', () => {
    const text = sentencesToText([
      { media_channel: 1, transcript: 'Hi, it is Josh.' },
      { media_channel: 1, transcript: 'About job 16234.' },
      { media_channel: 2, transcript: 'Hi Josh.' },
      { media_channel: 2, transcript: '  ' },
      { media_channel: 1, text: 'Thanks.' },
    ], channelSpeakers('inbound', 'call'));
    expect(text).toBe('Caller: Hi, it is Josh. About job 16234.\nOoosh: Hi Josh.\nCaller: Thanks.');
  });
});
