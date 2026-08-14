import aws_cdk as cdk
from aws_cdk import aws_ecr as ecr
from constructs import Construct

# How many releases the repository keeps. Each deploy pushes a new immutable
# tag, so this is the rollback window: any of these can be redeployed by
# passing its tag back to `-c imageTag=`.
#
# Set well above any plausible run of pushes because an ECR lifecycle rule
# cannot see ECS: it expires by push date alone, so a tag the service is
# *currently running* is eligible once enough newer images exist. Running
# tasks survive that — they already pulled — but the next placement (a Spot
# reclaim, a scale-out, or the circuit breaker's own rollback) fails with
# CannotPullContainerError. The exposure is real after a rollback, where the
# live tag is deliberately an old one. Storage is a few cents a month, so the
# headroom is close to free.
RELEASES_KEPT = 30


class RegistryStack(cdk.Stack):
    """The ECR repository holding the `web/` container image.

    Separate from BackendStack for the same reason DataStack holds RDS and
    S3: its contents outlive any particular service. This also makes a first
    deploy possible — the ECS service names an image tag, so the repository
    must exist and hold that image before the service is created.
    If both lived in one stack, the circuit breaker would roll a first
    deploy back with nothing to pull, and the retained repository would then
    collide by name with the next attempt — a state no retry clears.
    """

    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        self.repository = ecr.Repository(
            self,
            "BackendRepository",
            repository_name="ai-gaussian-splatter-backend",
            # The images are the deployable artifact; tearing down the service
            # should never discard them.
            removal_policy=cdk.RemovalPolicy.RETAIN,
            image_scan_on_push=True,
            # A tag, once pushed, can never be repointed. This is what makes
            # the deployment circuit breaker's rollback mean anything: the
            # previous task definition names a tag that still resolves to the
            # image it was deployed with, so ECS re-pulls that rather than
            # whatever was pushed most recently. Re-pushing a tag fails
            # outright — rebuild under a new commit instead.
            image_tag_mutability=ecr.TagMutability.IMMUTABLE,
            # Every deploy pushes a new tag and nothing is ever orphaned, so
            # the cap is on releases rather than on untagged leftovers.
            lifecycle_rules=[
                ecr.LifecycleRule(
                    max_image_count=RELEASES_KEPT,
                    description=f"Keep the last {RELEASES_KEPT} releases as the rollback window",
                ),
            ],
        )
