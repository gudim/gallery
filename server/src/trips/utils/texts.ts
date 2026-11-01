import { TripKind } from 'src/trips/enum.js';

// Prompts, response schemas and answer checks of trip texts (trips PLAN §2.6), ported from travel-album's
// atlas/texts/{prompts,generate}.py. The prompts are in English and name the trip's language (DECISIONS-LOG 2026-11-01).

/** Assets per model call; the next call gets the captions of the previous one. */
export const TRIP_TEXTS_CHUNK = 30;

/** Text sources generation may replace without "replace my texts too" (travel-album P15). */
export const TRIP_TEXT_SOURCE_GENERATED = 'generated';
const REPLACEABLE_SOURCES = new Set([TRIP_TEXT_SOURCE_GENERATED, 'geocoded']);

export const isReplaceableText = (value: string | null, source: string | null, overwrite: boolean) =>
  overwrite || !value || (source !== null && REPLACEABLE_SOURCES.has(source));

/** An asset's caption may be replaced while it is empty or still the text an LLM wrote (DECISIONS-LOG 2026-10-31). */
export const isReplaceableCaption = (description: string | null, generated: string | null, overwrite: boolean) =>
  overwrite || !description || description === generated;

export type TripTextPlanStop = {
  ownerId: string;
  isAtCenter: boolean;
  title: string | null;
  titleSource: string | null;
  story: string | null;
  storySource: string | null;
};
export type TripTextPlanAsset = {
  id: string;
  ownerId: string;
  description: string | null;
  generatedCaption: string | null;
};

/**
 * What generation of a stop writes and how many calls it takes, and how many of the owner's texts it leaves alone
 * without "replace my texts too". One function for the estimate and the job, so the window promises what the job does
 * (travel-album's stop_work). Only the album owner's own assets get captions: a caption is the asset's description.
 */
export const planStopTexts = (stop: TripTextPlanStop, assets: TripTextPlanAsset[], overwrite: boolean) => {
  const hasTitle = !stop.isAtCenter;
  const ownAssets = assets.filter((asset) => asset.ownerId === stop.ownerId);
  const wantTitle = hasTitle && isReplaceableText(stop.title, stop.titleSource, overwrite);
  const wantStory = isReplaceableText(stop.story, stop.storySource, overwrite);
  const captionIds = ownAssets
    .filter((asset) => isReplaceableCaption(asset.description, asset.generatedCaption, overwrite))
    .map((asset) => asset.id);
  const isNeeded = assets.length > 0 && (wantTitle || wantStory || captionIds.length > 0);
  const ownTexts =
    Number(hasTitle && !isReplaceableText(stop.title, stop.titleSource, false)) +
    Number(!isReplaceableText(stop.story, stop.storySource, false)) +
    ownAssets.filter((asset) => !isReplaceableCaption(asset.description, asset.generatedCaption, false)).length;
  return {
    wantTitle,
    wantStory,
    captionIds,
    calls: isNeeded ? Math.ceil(assets.length / TRIP_TEXTS_CHUNK) : 0,
    ownTexts,
  };
};

/** The short and the long caption in one Immich description, after a blank line (trips ADR 0002). */
export const joinCaption = (caption: string, long: string | null) => (long ? `${caption}\n\n${long}` : caption);

export class TripTextsError extends Error {
  constructor(
    message: string,
    // false: a settings problem that a retry cannot fix.
    readonly isRetryable = true,
  ) {
    super(message);
  }
}

export type TripTextPart = { type: 'text'; text: string } | { type: 'image'; data: Buffer; mimeType: string };

const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

const STYLE = (language: string) =>
  `Write in ${languageName(language)}, as a companion who knows the history and geography of the places well: concretely, ` +
  'with names, dates and an explanation of why a place looks the way it does. Do not make things up: if a fact does ' +
  'not follow from the photo and the data given, describe what is visible.';

const CAPTION_RULES =
  '- Caption: one sentence about what is in the photo.\n' +
  '- Long caption: two to four sentences of background (history, geography, how the place works) for photos there ' +
  'is something to tell about; null for the rest.\n\n' +
  'Neighbouring photos are often alike. Do not repeat what earlier captions said: name another detail.';

const stopSystem = (kind: TripKind, language: string) => {
  switch (kind) {
    case TripKind.Places: {
      return (
        'You write the texts of a photo album of places: the title and story of a place and the captions of its ' +
        'photos. This is not a journey in order: the author came back to a place, sometimes in different years, and ' +
        `its photos come from different visits.\n\n${STYLE(language)}\n\n` +
        '- Title: the name of the place, refined after a dash if needed, such as "Vilnius — Užupis".\n' +
        '- Story: one to three sentences: what the place is and what it was like in the visits the photos show. Do ' +
        'not build a route: no "then", "next" or "the following day", there is no order between places.\n' +
        CAPTION_RULES
      );
    }
    case TripKind.Plain: {
      return (
        'You write the texts of a photo album without a map: the title and story of a section and the captions of ' +
        `its photos. A section is one day of shooting.\n\nWrite in ${languageName(language)}, concretely and simply. ` +
        'Where the photos were taken is unknown: do not guess the place and do not name cities or countries unless ' +
        'they are visible in the photos. Do not make things up: describe what is visible.\n\n' +
        '- Title: a few words on what the day was by its photos; not the date, the album shows it.\n' +
        '- Story: one to three sentences on what happened that day.\n' +
        CAPTION_RULES
      );
    }
    default: {
      return (
        'You write the texts of a trip photo album: the title and story of a stop and the captions of its photos.' +
        `\n\n${STYLE(language)}\n\n` +
        '- Title: the name of the place, refined after a dash if needed, such as "Warsaw — Old Town".\n' +
        '- Story: one to three sentences: what the place is and why it matters on this trip.\n' +
        CAPTION_RULES
      );
    }
  }
};

const placeSystem = (language: string) =>
  'You write an article about a place for a trip photo album: where it came from, how it is laid out, why it looks ' +
  `the way it does and why people go there.\n\nWrite in ${languageName(language)}, three to six paragraphs separated ` +
  'by a blank line, without headings or lists. Rely on the titles and stories of the trip’s stops at this place; do ' +
  'not make up facts.';

// Wall-clock times are stored as UTC (trip_stop.localStart, asset.localDateTime), so their UTC fields are local.
const day = (at: Date) => at.toISOString().slice(0, 10);
const time = (at: Date) => at.toISOString().slice(11, 16);
const when = (start: Date | null, end: Date | null) =>
  start ? `${day(start)}, ${time(start)}${end && end.getTime() !== start.getTime() ? `–${time(end)}` : ''}` : '';
const span = (start: Date | null, end: Date | null) => {
  if (!start) {
    return '';
  }
  const [first, last] = [day(start), day(end ?? start)];
  return first === last ? first : `from ${first} to ${last}`;
};
// Places trips need the date of each photo: one stop holds visits of different years.
const frameAt = (kind: TripKind, at: Date | null) =>
  at ? (kind === TripKind.Places ? `${day(at)} ${time(at)}` : time(at)) : '';

export type TripTextStop = {
  albumName: string;
  kind: TripKind;
  language: string;
  title: string | null;
  isAtCenter: boolean;
  region: string | null;
  country: string | null;
  localStart: Date | null;
  localEnd: Date | null;
  placeTitle: string | null;
  article: string | null;
};

export type TripTextFrame = { isVideo: boolean; localDateTime: Date | null };
export type TripTextCaption = { caption: string; long: string | null };

/**
 * The input of one call for a chunk of a stop's photos, each numbered from 1 in the chunk. `previous` are the captions
 * of the previous chunk; `written` the title and story the first chunk wrote (null: this is the first chunk).
 */
export const stopRequest = (
  stop: TripTextStop,
  frames: Array<TripTextFrame & { image: { data: Buffer; mimeType: string } }>,
  previous: Array<TripTextFrame & TripTextCaption>,
  written: { title: string; story: string } | null,
) => {
  const lines = [`Album: ${stop.albumName}`];
  if (stop.kind === TripKind.Plain) {
    if (stop.title) {
      lines.push(`Current section title: ${stop.title}`);
    }
    lines.push(stop.localStart ? `Day: ${day(stop.localStart)}` : 'Day: undated');
  } else {
    if (stop.placeTitle) {
      lines.push(`Place: ${stop.placeTitle}`);
    }
    if (stop.isAtCenter) {
      lines.push(
        `These are photos near the album's centre without an exact place: "${stop.title ?? ''}". They were taken at ` +
          'different spots around the centre; no title is needed, the story is about the centre and its surroundings.',
      );
    } else if (stop.title) {
      lines.push(`Current stop title: ${stop.title}`);
    }
    const where = [stop.region, stop.country].filter(Boolean).join(', ');
    if (where) {
      lines.push(`Region: ${where}`);
    }
    if (stop.kind === TripKind.Places) {
      const dates = span(stop.localStart, stop.localEnd);
      if (dates) {
        lines.push(`Photos taken: ${dates}; each photo has its visit's date`);
      }
    } else {
      const dates = when(stop.localStart, stop.localEnd);
      if (dates) {
        lines.push(`Time: ${dates}`);
      }
    }
    if (stop.article) {
      lines.push(`Article about the place:\n${stop.article}`);
    }
  }
  if (written) {
    lines.push(`The stop's title and story are already written.\nTitle: ${written.title}\nStory: ${written.story}`);
  }
  if (previous.length > 0) {
    lines.push(
      "Captions of this stop's previous photos:\n" +
        previous
          .map((frame) => `- ${frameAt(stop.kind, frame.localDateTime)} ${joinCaption(frame.caption, frame.long)}`)
          .join('\n'),
    );
  }
  const task = written
    ? 'Write the captions of the photos below, continuing the previous ones; return empty strings in title and story.'
    : "Write the stop's title, its story and the captions of all photos below.";
  lines.push(`${task} In captions give exactly one entry for each photo number, no more and no fewer.`);

  const parts: TripTextPart[] = [{ type: 'text', text: lines.join('\n\n') }];
  for (const [index, frame] of frames.entries()) {
    const at = frameAt(stop.kind, frame.localDateTime);
    parts.push(
      {
        type: 'text',
        text: [`Photo ${index + 1}`, at, frame.isVideo ? 'video, poster' : 'photo'].filter(Boolean).join(' · '),
      },
      { type: 'image', ...frame.image },
    );
  }
  return { system: stopSystem(stop.kind, stop.language), parts, schema: STOP_SCHEMA };
};

export type TripTextPlaceStop = {
  title: string | null;
  story: string | null;
  region: string | null;
  country: string | null;
  localStart: Date | null;
  localEnd: Date | null;
};

export const placeRequest = (
  place: { albumName: string; kind: TripKind; language: string; title: string | null; key: string },
  stops: TripTextPlaceStop[],
) => {
  const lines = [`Album: ${place.albumName}`, `Place: ${place.title || place.key}`];
  const dates = place.kind === TripKind.Places ? span : when;
  for (const stop of stops) {
    const where = [stop.region, stop.country].filter(Boolean).join(', ');
    const head = [stop.title, where, dates(stop.localStart, stop.localEnd)].filter(Boolean).join(' · ');
    lines.push(`Stop: ${head}${stop.story ? `\n${stop.story}` : ''}`);
  }
  lines.push('Write the article about the place.');
  const parts: TripTextPart[] = [{ type: 'text', text: lines.join('\n\n') }];
  return { system: placeSystem(place.language), parts, schema: PLACE_SCHEMA };
};

const STOP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    story: { type: 'string' },
    captions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          photo: { type: 'integer' },
          caption: { type: 'string' },
          long_caption: { type: ['string', 'null'] },
        },
        required: ['photo', 'caption', 'long_caption'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'story', 'captions'],
  additionalProperties: false,
};

const PLACE_SCHEMA = {
  type: 'object',
  properties: { article: { type: 'string' } },
  required: ['article'],
  additionalProperties: false,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A chunk's answer: the title, the story and a caption for each photo, by its index in the chunk. The photo numbers
 * must be exactly those sent; any other answer is refused whole and writes nothing.
 */
export const checkStopAnswer = (answer: unknown, count: number) => {
  if (
    !isObject(answer) ||
    typeof answer.title !== 'string' ||
    typeof answer.story !== 'string' ||
    !Array.isArray(answer.captions)
  ) {
    throw new TripTextsError('The model did not answer by the schema: title, story and captions are needed');
  }
  const captions = new Map<number, TripTextCaption>();
  for (const entry of answer.captions as unknown[]) {
    if (
      !isObject(entry) ||
      !Number.isSafeInteger(entry.photo) ||
      typeof entry.caption !== 'string' ||
      !(entry.long_caption === null || typeof entry.long_caption === 'string')
    ) {
      throw new TripTextsError('The model did not answer by the schema: an entry of captions');
    }
    const photo = entry.photo as number;
    if (captions.has(photo)) {
      throw new TripTextsError(`Photo ${photo} is twice in the answer`);
    }
    captions.set(photo, { caption: entry.caption.trim(), long: (entry.long_caption as string | null)?.trim() || null });
  }
  const expected = Array.from({ length: count }, (_, index) => index + 1);
  if (captions.size !== count || expected.some((photo) => !captions.has(photo))) {
    throw new TripTextsError(
      `The photos in the answer do not match the request: got ${captions.keys().toArray().join(', ')}, sent 1–${count}`,
    );
  }
  return {
    title: answer.title.trim(),
    story: answer.story.trim(),
    captions: expected.map((photo) => captions.get(photo)!),
  };
};

/** An article, paragraphs separated by one blank line. */
export const checkPlaceAnswer = (answer: unknown) => {
  if (!isObject(answer) || typeof answer.article !== 'string') {
    throw new TripTextsError('The model did not answer by the schema: article is needed');
  }
  return answer.article
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join('\n\n');
};
