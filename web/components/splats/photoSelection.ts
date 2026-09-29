// A photo picked in the grid or the 3D view on the splat page. Every pick is a new object, even of the same photo, so
// picking it again after orbiting away flies the view back to it and turns the grid back to its page.
export interface PhotoSelection {
  photoId: string;
}
