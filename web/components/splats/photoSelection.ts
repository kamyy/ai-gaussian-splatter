/**
 * The type for the photo picked on a splat's page.
 *
 * A photo is picked from the grid. Every pick is a new object, even of the same photo, so picking it again after
 * orbiting away flies the view back to it and turns the grid back to its page. The photo the page opens on carries
 * opening, so that arrival does not count as one of those picks.
 */

export interface PhotoSelection {
  photoId: string;
  // True for the photo chosen as the page opens. A pick from the grid leaves this off.
  opening?: boolean;
}
