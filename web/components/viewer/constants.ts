// COLMAP's reconstruction scale and origin are arbitrary per capture (see PointCloudScene.tsx's camera-framing
// comments), so no fixed length is universally "correct" here — this is a coarse orientation cue for the origin
// marker in both SplatViewer.tsx and PointCloudScene.tsx, not a scaled measurement.
export const AXES_HELPER_SIZE = 0.5;
