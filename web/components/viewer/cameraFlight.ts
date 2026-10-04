/**
 * The maths behind flying the 3D view to a photo's viewpoint.
 *
 * Pure functions, with no React, that work out the camera pose that sees what a photo saw, the field of view that fits
 * the photo's frame, and the in-between poses of the flight. web/lib/hooks/useCameraFlight.ts animates the view with
 * them.
 */

import { MathUtils, Matrix4, Quaternion, Vector3 } from "three";

import type { CameraPose } from "@/lib/types";

// The shortest orbit distance a flight ends on, as a fraction of the photo's distance from the orbit target. It only
// applies when the target is beside or behind the photo, where projecting it onto the photo's view gives little or
// none.
const MIN_DISTANCE_FRACTION = 0.1;

export interface ViewPose {
  position: Vector3;
  quaternion: Quaternion;
  // How far in front of the camera the orbit target sits.
  distance: number;
}

/**
 * The viewer's camera pose that sees what a photo saw: at the photo's position, looking along its optical axis, rolled
 * the way the photo was. The orbit target goes where the photo's optical axis passes orbitTarget, so orbiting
 * afterwards circles the object.
 */
export function photoViewPose(camera: Omit<CameraPose, "photoId">, orbitTarget: Vector3): ViewPose {
  const position = new Vector3(...camera.center);

  // COLMAP's rotation is world-to-camera, so its rows are the photo's axes in world space: x right, y down the image,
  // and z the viewing direction.
  const forward = new Vector3(...camera.rotation[2]).normalize();
  const up = new Vector3(...camera.rotation[1]).negate().normalize();
  const toTarget = orbitTarget.clone().sub(position);
  const distance = Math.max(toTarget.dot(forward), MIN_DISTANCE_FRACTION * toTarget.length(), 1e-6);

  // Matrix4.lookAt orients an object's -z toward the target, which is the way a Three.js camera looks.
  const rotation = new Matrix4().lookAt(position, position.clone().add(forward), up);

  return { position, quaternion: new Quaternion().setFromRotationMatrix(rotation), distance };
}

/**
 * The vertical field of view, in degrees, that just fits a photo's frame inside a view of the given aspect (width over
 * height). A view wider than the photo matches the photo's vertical field of view. A narrower one widens it until the
 * photo's full width fits.
 */
export function fittedFov({ width, height, fx, fy }: Omit<CameraPose, "photoId">, aspect: number): number {
  // Half the image's size over the focal length, both in pixels, is the tangent of the half-angle.
  const tanHalfVertical = Math.max(height / (2 * fy), width / (2 * fx) / aspect);

  return MathUtils.radToDeg(2 * Math.atan(tanHalfVertical));
}

/**
 * The orthographic zoom that shows the same height fittedFov would at distance, for a camera whose view is
 * frustumHeight world units tall at zoom 1.
 */
export function orthographicZoom(
  frustumHeight: number,
  photo: Omit<CameraPose, "photoId">,
  distance: number,
  aspect: number,
): number {
  const tanHalfVertical = Math.tan(MathUtils.degToRad(fittedFov(photo, aspect) / 2));
  const visibleHeight = 2 * distance * tanHalfVertical;

  return frustumHeight / visibleHeight;
}

/**
 * The pose a fraction t of the way from one pose to another. The position moves in a straight line and the
 * orientation turns at a steady rate, so the view doesn't swing wide the way separately interpolated angles would.
 */
export function interpolatePose(from: ViewPose, to: ViewPose, t: number): ViewPose {
  return {
    position: new Vector3().lerpVectors(from.position, to.position, t),
    quaternion: new Quaternion().slerpQuaternions(from.quaternion, to.quaternion, t),
    distance: from.distance + (to.distance - from.distance) * t,
  };
}

/** The point a pose orbits around: distance along the direction the pose looks. */
export function orbitTargetOf({ position, quaternion, distance }: ViewPose): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(quaternion).multiplyScalar(distance).add(position);
}

/** Starts and ends gently, which reads as the camera easing into motion rather than jumping to full speed. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
