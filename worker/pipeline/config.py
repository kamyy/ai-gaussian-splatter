"""The worker's settings, read from environment variables.

web/lib/server/workerLauncher.ts sets these in the instance's startup script: which worker job and splat to work on,
where to report status, the S3 buckets to read and write, where their credentials come from, and which stage to run.
pydantic validates them when the worker starts, so a missing setting fails straight away rather than partway through a
GPU run.
"""

from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Env vars set in the EC2 launch UserData (web/lib/server/workerLauncher.ts)."""

    model_config = SettingsConfigDict(env_prefix="")

    job_id: str
    splat_id: str
    callback_token: str
    app_origin: str
    uploads_bucket: str
    splats_bucket: str

    # Which half of the pipeline this instance runs. Split across two instances so a user can inspect the COLMAP point
    # cloud before paying for training: "reconstruct" self-terminates at awaiting_training, "train" is launched later
    # by a separate POST /api/v1/splats/[splatId]/train call reusing the same job_id/callback_token.
    stage: Literal["reconstruct", "train"] = "reconstruct"

    # Single-object-against-plain-background scenes converge well below the paper's 30k default.
    training_iterations: int = 10_000

    # A local experiment switch, never set on AWS. worker/pipeline/train.py holds back every 8th photo from training
    # and scores the finished splat against them, since the training loss keeps falling even while the splat overfits
    # the photos it trains on. It also seeds the random view order. GPU nondeterminism still moves the score of two
    # identical runs by up to about 1 dB. Compare a change over several runs.
    eval_holdout: bool = False

    local_workdir: str = "/tmp/job"

    # Set by web/lib/server/workerLauncher.ts's user-data, because a worker instance's own role has no S3 access.
    # worker/pipeline/storage.py then asks the app for credentials scoped to this splat. Unset on a local run, which
    # uses the dev IAM user's keys instead.
    s3_credentials_from_app: bool = False

    # Epoch milliseconds at which the instance finished booting, stamped by the launch's user-data. Reported with the
    # stage's first status so the web app can split the stage's start-up into boot and image pull. Unset on a local run.
    booted_at: int | None = None


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from env vars
