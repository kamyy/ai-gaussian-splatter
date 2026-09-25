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

    # "Fast test mode" — tiny photo set, 20 iterations, for a cheap on-demand smoke test of the plumbing without
    # full-quality training cost. worker/pipeline/train.py scales its densify/log schedules to the iteration count,
    # so the short run covers the same code paths as a full one.
    fast_test_mode: bool = False

    # Set only on a train-stage launch, as JSON in CROP_BOX. worker/pipeline/export.py drops every Gaussian whose center
    # falls outside it. Training ignores it, for the reason ARCHITECTURE.md's Pipeline section gives.
    crop_box: CropBox | None = None

    local_workdir: str = "/tmp/job"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from env vars
