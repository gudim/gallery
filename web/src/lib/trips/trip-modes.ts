// Side-view avatars drawn on a leg, nose to the right, in a 40×40 box (travel-album static/modes.js, approved by
// its owner on 2026-09-28). Classes are painted by trip-theme.css: b/bl the body in the day colour, k/kl/kr dark parts,
// w/wl light parts, wv the wave.
import { TripLegMode } from '@immich/sdk';

export const MODE_ART: Partial<Record<TripLegMode, string>> = {
  [TripLegMode.Foot]:
    '<path class="kl" d="M19 22l-3.5 6-3 5M19 22l4.5 5.5 1 6"/>' +
    '<path class="kl" d="M20 14l-4 5M21 14l4.5 4.5"/>' +
    '<rect class="k" x="13.5" y="11" width="5" height="8" rx="1.8"/>' +
    '<path class="bl" d="M20.5 13 19 22.5"/>' +
    '<circle class="b" cx="22" cy="7" r="3.8"/>',
  [TripLegMode.Bicycle]:
    '<circle class="kr" cx="9.5" cy="27.5" r="6.2"/><circle class="kr" cx="30.5" cy="27.5" r="6.2"/>' +
    '<path class="bl" d="M9.5 27.5 16 18h11l3.5 9.5M16 18l4 9.5-10.5 0M20 27.5 27 18M27 18l.8-4.5h2.5"/>' +
    '<path class="kl" d="M17.5 17 20 22.5l-1 5M22 9.5l6 5"/>' +
    '<path class="bl" d="M16.5 17 22 9.5"/>' +
    '<circle class="b" cx="23.5" cy="6.2" r="3.4"/>',
  [TripLegMode.Driving]:
    '<path class="b" d="M2.5 27v-5.2c0-1.5.9-2.4 2.4-2.7l5.6-1.1 4.6-5.6c.6-.7 1.4-1.1 2.3-1.1h8.4' +
    'c1 0 1.9.4 2.5 1.2l4.4 5.5 3.6.8c1.6.4 2.5 1.6 2.5 3.1V27Z"/>' +
    '<path class="w" d="M13.5 18.2 17 13.8c.3-.3.6-.5 1-.5h3.1v4.9ZM22.9 13.3h2.7c.5 0 .9.2 1.2.6l3.4 4.3h-7.3Z"/>' +
    '<rect class="w" x="34.5" y="21" width="3" height="2" rx="1"/>' +
    '<circle class="k" cx="11" cy="27.5" r="4.6"/><circle class="w" cx="11" cy="27.5" r="1.7"/>' +
    '<circle class="k" cx="29.5" cy="27.5" r="4.6"/><circle class="w" cx="29.5" cy="27.5" r="1.7"/>',
  [TripLegMode.Bus]:
    '<path class="b" d="M2 10.5C2 9.1 3.1 8 4.5 8h27c2.4 0 4.3 1.6 4.9 3.9l1.6 7.1V26c0 .6-.4 1-1 1H3' +
    'c-.6 0-1-.4-1-1Z"/>' +
    '<path class="w" d="M4.5 11h5v6h-5ZM11.5 11h5v6h-5ZM18.5 11h5v6h-5ZM25.5 11h4.5v6h-4.5Z' +
    'M32 11h1.2c1 0 1.9.7 2.1 1.7l1.2 5.3H32Z"/>' +
    '<rect class="k" x="2" y="20.5" width="36" height="1.6"/>' +
    '<circle class="k" cx="9.5" cy="27.5" r="4"/><circle class="w" cx="9.5" cy="27.5" r="1.5"/>' +
    '<circle class="k" cx="30" cy="27.5" r="4"/><circle class="w" cx="30" cy="27.5" r="1.5"/>',
  [TripLegMode.Train]:
    '<path class="kl" d="M1.5 32.5h37"/>' +
    '<path class="b" d="M2 11c0-1.1.9-2 2-2h22c5.6 0 10.3 4.1 11.4 9.6L39 27H2Z"/>' +
    '<path class="w" d="M5 12.5h5.5v5.5H5ZM13 12.5h5.5v5.5H13ZM21 12.5h5.5v5.5H21Z' +
    'M29 12.5h1c2.6 0 4.9 1.9 5.6 4.5l.3 1H29Z"/>' +
    '<rect class="w" x="2" y="21" width="36" height="1.4"/>' +
    '<circle class="k" cx="7" cy="29.5" r="2.6"/><circle class="k" cx="13" cy="29.5" r="2.6"/>' +
    '<circle class="k" cx="27" cy="29.5" r="2.6"/><circle class="k" cx="33" cy="29.5" r="2.6"/>',
  [TripLegMode.Boat]:
    '<path class="wv" d="M1 34.5c3 0 3-1.6 6-1.6s3 1.6 6 1.6 3-1.6 6-1.6 3 1.6 6 1.6 3-1.6 6-1.6 3 1.6 6 1.6"/>' +
    '<rect class="b" x="14" y="6" width="5" height="7" rx="1"/><rect class="k" x="14" y="6" width="5" height="1.8"/>' +
    '<path class="w" d="M8 21v-7c0-.6.4-1 1-1h17.5c.5 0 .9.3 1 .8L29.5 21Z"/>' +
    '<path class="k" d="M10.5 15.5h3v2.5h-3ZM15.5 15.5h3v2.5h-3ZM20.5 15.5h3v2.5h-3Z"/>' +
    '<path class="b" d="M1.5 21H39l-5 9.5H6.5Z"/>' +
    '<path class="wl" d="M4 24h32"/>',
  [TripLegMode.Flight]:
    '<path class="b" d="M3.5 12 7 11l5.5 8h-8Z"/>' +
    '<path class="b" d="M4 19.5c0-1.4 1.1-2.5 2.5-2.5H31c3.5 0 6.6 1.6 7.5 3.5-.9 1.9-4 3.5-7.5 3.5H8' +
    'c-2.2 0-4-1.8-4-4.5Z"/>' +
    '<path class="w" d="M33 18.5h2.3c.8.4 1.5.9 2 1.5H33Z"/>' +
    '<path class="w" d="M11 20h1.6v1.6H11ZM14.5 20h1.6v1.6h-1.6ZM18 20h1.6v1.6H18ZM21.5 20h1.6v1.6h-1.6Z' +
    'M25 20h1.6v1.6H25ZM28.5 20h1.6v1.6h-1.6Z"/>' +
    '<path class="k" d="M15 22.5h9l-6.5 8.5h-3.2Z"/>',
};

/**
 * The transform of an avatar heading `angle` degrees on screen (0 right, clockwise): heading left it is mirrored, not
 * turned over, and it tilts at most 25°, so a train on a north–south leg does not stand on its end.
 */
export const avatarTransform = (angle: number) => {
  const flip = Math.abs(angle) > 90;
  let tilt = flip ? (angle > 0 ? angle - 180 : angle + 180) : angle;
  tilt = Math.max(-25, Math.min(25, tilt));
  return `${flip ? 'scaleX(-1) ' : ''}rotate(${Math.round(flip ? -tilt : tilt)}deg)`;
};
