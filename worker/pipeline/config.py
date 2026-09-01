from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Env vars set in the EC2 launch UserData (web/lib/server/ec2Launcher.ts)."""

    model_config = SettingsConfigDict(env_prefix="")

    job_id: str
    splat_id: str
    callback_token: str
    app_public_url: str
    uploads_bucket: str
    splats_bucket: str

    # Single-object-against-plain-background scenes converge well below the paper's 30k default.
    training_iterations: int = 10_000

    # "Fast test mode" — tiny photo set, 20 iterations, for a cheap on-demand smoke test of the plumbing without
    # full-quality training cost. worker/pipeline/train.py scales its densify/log schedules to the iteration count,
    # so the short run covers the same code paths as a full one.
    fast_test_mode: bool = False

    local_workdir: str = "/tmp/job"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from env vars
