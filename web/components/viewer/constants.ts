// COLMAP's reconstruction scale and origin are arbitrary per capture (see the camera-framing comments in
// web/components/viewer/SplatViewer.tsx), so no fixed length is universally "correct" here. It is a coarse
// orientation cue for the origin marker in web/components/viewer/SplatViewer.tsx and
// web/components/viewer/PointCloudScene.tsx, not a scaled measurement.
export const AXES_HELPER_SIZE = 0.5;
