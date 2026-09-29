/**
 * The type for the photo picked on a splat's page.
 *
 * A photo can be picked in the grid or in the 3D view, and both show the same selection. Every pick is a new object,
 * even of the same photo, so picking it again after orbiting away flies the view back to it and turns the grid back to
 * its page.
 */

export interface PhotoSelection {
  photoId: string;
}
