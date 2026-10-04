/**
 * The type for the photo picked on a splat's page.
 *
 * A photo is picked from the grid. Every pick is a new object, even of the same photo, so picking it again after
 * orbiting away flies the view back to it and turns the grid back to its page.
 */

export interface PhotoSelection {
  photoId: string;
}
