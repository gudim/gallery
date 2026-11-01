import { afterEach, describe, expect, it, vi } from 'vitest';
import { TripKind } from 'src/trips/enum.js';
import { completeTripText } from 'src/trips/utils/llm-client.js';
import {
  TripTextsError,
  checkPlaceAnswer,
  checkStopAnswer,
  isReplaceableCaption,
  isReplaceableText,
  joinCaption,
  placeRequest,
  stopRequest,
} from 'src/trips/utils/texts.js';

const stop = {
  albumName: 'Lithuania 2026',
  kind: TripKind.Route,
  language: 'ru',
  title: 'Biržai',
  isAtCenter: false,
  region: 'Panevėžys County',
  country: 'Lithuania',
  localStart: new Date('2026-04-12T10:05:00Z'),
  localEnd: new Date('2026-04-12T12:40:00Z'),
  placeTitle: null,
  article: null,
};
const image = { data: Buffer.from('jpeg'), mimeType: 'image/jpeg' };
const frame = (minute: number) => ({ isVideo: false, localDateTime: new Date(`2026-04-12T10:${minute}:00Z`) });

const answer = (photos: number[]) => ({
  title: ' Biržai ',
  story: 'A story.',
  captions: photos.map((photo) => ({
    photo,
    caption: `Caption ${photo}`,
    long_caption: photo === 1 ? ' ' : 'Long.',
  })),
});

const reply = (content: string, finish = 'stop') =>
  Response.json({ choices: [{ finish_reason: finish, message: { content } }] });

describe('replaceable texts', () => {
  it('replaces empty, generated and geocoded texts, and the owner’s only on overwrite', () => {
    expect(isReplaceableText(null, null, false)).toBe(true);
    expect(isReplaceableText('Biržai', 'geocoded', false)).toBe(true);
    expect(isReplaceableText('Biržai', 'generated', false)).toBe(true);
    expect(isReplaceableText('Biržai', 'manual', false)).toBe(false);
    expect(isReplaceableText('Biržai', 'manual', true)).toBe(true);
  });

  it('replaces a caption only while it is empty or still the generated text', () => {
    expect(isReplaceableCaption(null, null, false)).toBe(true);
    expect(isReplaceableCaption('A castle.', 'A castle.', false)).toBe(true);
    expect(isReplaceableCaption('My castle.', 'A castle.', false)).toBe(false);
    expect(isReplaceableCaption('My castle.', null, true)).toBe(true);
  });

  it('joins the long caption after a blank line', () => {
    expect(joinCaption('A castle.', null)).toBe('A castle.');
    expect(joinCaption('A castle.', 'Built in 1586.')).toBe('A castle.\n\nBuilt in 1586.');
  });
});

describe(stopRequest.name, () => {
  it('asks the first chunk for title, story and captions, in the trip’s language', () => {
    const { system, parts } = stopRequest(
      stop,
      [
        { ...frame(10), image },
        { ...frame(20), image },
      ],
      [],
      null,
    );
    expect(system).toContain('Write in Russian');
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain('Current stop title: Biržai');
    expect(text).toContain('Region: Panevėžys County, Lithuania');
    expect(text).toContain('Time: 2026-04-12, 10:05–12:40');
    expect(text).toContain("Write the stop's title");
    expect(parts.slice(1).map((part) => part.type)).toEqual(['text', 'image', 'text', 'image']);
    expect(parts[1]).toEqual({ type: 'text', text: 'Photo 1 · 10:10 · photo' });
  });

  it('gives a later chunk the title, story and the previous captions', () => {
    const { parts } = stopRequest(
      stop,
      [{ ...frame(30), image }],
      [{ ...frame(20), caption: 'A castle.', long: 'Built in 1586.' }],
      { title: 'Biržai — the castle', story: 'A story.' },
    );
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain('Title: Biržai — the castle');
    expect(text).toContain('- 10:20 A castle.\n\nBuilt in 1586.');
    expect(text).toContain('return empty strings in title and story');
  });

  it('names no place for a trip without a map', () => {
    const { system, parts } = stopRequest({ ...stop, kind: TripKind.Plain }, [{ ...frame(10), image }], [], null);
    expect(system).toContain('without a map');
    expect((parts[0] as { text: string }).text).not.toContain('Region');
  });
});

describe(placeRequest.name, () => {
  it('builds the article from the place’s stops', () => {
    const { system, parts } = placeRequest(
      { albumName: 'Lithuania 2026', kind: TripKind.Route, language: 'de', title: null, key: 'birzai' },
      [{ ...stop, story: 'A story.' }],
    );
    expect(system).toContain('Write in German');
    expect((parts[0] as { text: string }).text).toContain('Place: birzai');
    expect((parts[0] as { text: string }).text).toContain('Stop: Biržai · Panevėžys County, Lithuania');
  });
});

describe(checkStopAnswer.name, () => {
  it('returns the captions in photo order', () => {
    expect(checkStopAnswer(answer([2, 1]), 2)).toEqual({
      title: 'Biržai',
      story: 'A story.',
      captions: [
        { caption: 'Caption 1', long: null },
        { caption: 'Caption 2', long: 'Long.' },
      ],
    });
  });

  it('refuses an answer whose photos differ from those sent', () => {
    expect(() => checkStopAnswer(answer([1, 3]), 2)).toThrow(TripTextsError);
    expect(() => checkStopAnswer(answer([1]), 2)).toThrow(TripTextsError);
    expect(() => checkStopAnswer(answer([1, 1]), 2)).toThrow('twice');
    expect(() => checkStopAnswer({ title: 'x' }, 2)).toThrow(TripTextsError);
  });
});

describe(checkPlaceAnswer.name, () => {
  it('keeps paragraphs apart by one blank line', () => {
    expect(checkPlaceAnswer({ article: ' One.\n\n\n Two. \n' })).toBe('One.\n\nTwo.');
    expect(() => checkPlaceAnswer({})).toThrow(TripTextsError);
  });
});

describe(completeTripText.name, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const config = { url: 'https://llm.example/v1/', model: 'small', key: 'sk-1', userAgent: 'test' };
  const request = {
    system: 'S',
    parts: [
      { type: 'text' as const, text: 'T' },
      { type: 'image' as const, ...image },
    ],
    schema: {},
  };
  it('posts a strict JSON schema request and parses the answer', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply('{"article":"A."}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeTripText(config, request)).resolves.toEqual({ article: 'A.' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://llm.example/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');
    const body = JSON.parse(init!.body as string);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${image.data.toString('base64')}`);
  });

  it('sends no Authorization header without a key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await completeTripText({ ...config, key: null }, request);
    expect(fetchMock.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
  });

  it('marks settings errors as not retryable and the rest as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('bad key', { status: 401 })));
    await expect(completeTripText(config, request)).rejects.toMatchObject({ isRetryable: false });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('busy', { status: 503 })));
    await expect(completeTripText(config, request)).rejects.toMatchObject({ isRetryable: true });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(reply('{', 'length')));
    await expect(completeTripText(config, request)).rejects.toThrow('The model stopped: length');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(completeTripText(config, request)).rejects.toMatchObject({ isRetryable: true });
  });
});
