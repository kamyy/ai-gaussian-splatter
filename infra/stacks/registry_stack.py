import aws_cdk as cdk
from aws_cdk import aws_ecr as ecr
from constructs import Construct

# The image tag BackendStack's service is pinned to, and the tag a deploy
# pushes. Kept here rather than in backend_stack.py because the push happens
# against this stack's repository, before BackendStack exists at all.
IMAGE_TAG = "latest"


class RegistryStack(cdk.Stack):
    """The ECR repository holding the `web/` container image.

    Separate from BackendStack because its contents outlive any particular
    service, the same reason DataStack holds RDS and S3. Keeping it apart is
    also what makes a first deploy possible: the ECS service is pinned to an
    image tag, so the repository has to exist and hold an image *before* the
    service is created. If both lived in one stack, the service's tasks would
    have nothing to pull, the deployment circuit breaker would roll the stack
    back, and the retained repository would then collide by name with the
    next attempt to create it — a state no retry can clear.
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
        )
