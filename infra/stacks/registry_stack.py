import aws_cdk as cdk
from aws_cdk import aws_ecr as ecr
from constructs import Construct

# The image tag BackendStack's service is pinned to, and the tag a deploy
# pushes. Kept here rather than in backend_stack.py because the push happens
# against this stack's repository, before BackendStack exists at all.
IMAGE_TAG = "latest"


class RegistryStack(cdk.Stack):
    """The ECR repository holding the `web/` container image.

    Separate from BackendStack for the same reason DataStack holds RDS and
    S3: its contents outlive any particular service. This also makes a first
    deploy possible — the ECS service is pinned to an image tag, so the
    repository must exist and hold an image before the service is created.
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
            # Pushing to a fixed tag leaves the image it replaced behind,
            # untagged and unreferenced, on every deploy. A week is long
            # enough to retag one by digest to roll back.
            lifecycle_rules=[
                ecr.LifecycleRule(
                    tag_status=ecr.TagStatus.UNTAGGED,
                    max_image_age=cdk.Duration.days(7),
                    description="Expire images orphaned by a push to the fixed tag",
                ),
            ],
        )
