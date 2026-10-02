"""The worker's settings, read from environment variables.

web/lib/server/ec2Launcher.ts sets these in the instance's startup script: which worker job and splat to work on, where
to report status, the S3 buckets to read and write, where their credentials come from, and which stage to run. pydantic
validates them when the worker starts, so a missing setting fails straight away rather than partway through a GPU run.
"""

from typing import Literal

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class CropBox(BaseModel):
    """An oriented box in the COLMAP point cloud's world frame, as the browser's crop gizmo leaves it. size is the full
    edge length on each of the box's own axes. quaternion is x, y, z, w, which is three.js's order, not COLMAP's.
    """

    center: tuple[float, float, float]
    size: tuple[float, float, float]
    quaternion: tuple[float, float, float, float]


class Settings(BaseSettings):
    """Env vars set in the EC2 launch UserData (web/lib/server/ec2Launcher.ts)."""

    model_config = SettingsConfigDict(env_prefix="")

    job_id: str
    splat_id: str
    callback_token: str
    app_public_url: str
    uploads_bucket: str
    splats_bucket: str

    # Which half of the pipeline this instance runs. Split across two instances so a user can inspect the COLMAP point
    # cloud before paying for training: "reconstruct" self-terminates at awaiting_training, "train" is launched later
    # by a separate POST /api/v1/splats/[splatId]/train call reusing the same job_id/callback_token.
    stage: Literal["reconstruct", "train"] = "reconstruct"

    # Single-object-against-plain-background scenes converge well below the paper's 30k default.
    training_iterations: int = 10_000

    # "Fast test mode": 20 training iterations instead of the full count, for a cheap smoke test of the plumbing. It
    # uses every photo, so it doesn't reduce GPU memory. worker/pipeline/train.py scales its densify and log schedules
    # to the iteration count, so the short run covers the same code paths as a full one.
    fast_test_mode: bool = False

    # A local experiment switch, never set on AWS. worker/pipeline/train.py holds back every 8th photo from training
    # and scores the finished splat against them, since the training loss keeps falling even while the splat overfits
    # the photos it trains on. It also seeds the random view order, but GPU nondeterminism still moves the score of two
    # identical runs by up to about 1 dB, so compare a change over several runs.
    eval_holdout: bool = False

    # Set only on a train-stage launch, as JSON in CROP_BOX. worker/pipeline/export.py drops every Gaussian whose center
    # falls outside it. Training ignores it, for the reason ARCHITECTURE.md's Pipeline section gives.
    crop_box: CropBox | None = None

    local_workdir: str = "/tmp/job"

    # Set by web/lib/server/ec2Launcher.ts's user-data, because a worker instance's own role has no S3 access.
    # worker/pipeline/storage.py then asks the app for credentials scoped to this splat. Unset on a local run, which
    # uses the dev IAM user's keys instead.
    s3_credentials_from_app: bool = False

    # Epoch milliseconds at which the instance finished booting, stamped by the launch's user-data. Reported with the
    # stage's first status so the web app can split the stage's start-up into boot and image pull. Unset on a local run.
    booted_at: int | None = None


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from env vars
