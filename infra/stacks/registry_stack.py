import aws_cdk as cdk
from aws_cdk import aws_ecr as ecr
from constructs import Construct

# How many releases the repository keeps. Each deploy pushes two immutable tags, $SHA-web and $SHA-migrate (see
# web/Dockerfile), capped by a rule per suffix below so this is a count of releases rather than of images.
#
# An ECR lifecycle rule cannot see ECS: it expires by push date alone, so a tag the service is *currently running* is
# eligible once enough newer images exist. Running tasks survive that, having already pulled. The next placement (a
# Spot reclaim, a scale-out, or the circuit breaker's own rollback) fails with CannotPullContainerError. The exposure is
# real after a rollback, where the live tag is deliberately an old one, so this is the number that protects it. Rolling
# back to $SHA also re-points MigrationTaskDefinition at $SHA-migrate, so both of a release's tags are kept to the same
# depth. Storage is nearly free regardless: every image shares one `pnpm install` layer (~237 MB compressed), and the
# per-release layers above it are a few hundred KB.
RELEASES_KEPT = 10


class RegistryStack(cdk.Stack):
    """The ECR repository holding the `web/` container image.

    Separate from WebStack for the same reason DataStack holds RDS and
    S3: its contents outlive any particular service. This also makes a first
    deploy possible. The ECS service names an image tag, so the repository
    must exist and hold that image before the ECS service is created.
    If both lived in one stack, the circuit breaker would roll a first
    deploy back with nothing to pull, and the retained repository would then
    collide by name with the next attempt — a state no retry clears.
    """

    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        self.repository = ecr.Repository(
            self,
            "WebRepository",
            # Repository holds both build targets of web/Dockerfile, distinguished by tag's -web/-migrate suffix.
            repository_name="ai-gaussian-splatter",
            # The images are the deployable artifact; tearing down the service should never discard them.
            removal_policy=cdk.RemovalPolicy.RETAIN,
            image_scan_on_push=True,
            # A tag, once pushed, can never be repointed. This is what makes the deployment circuit breaker's rollback
            # mean anything: the previous task definition names a tag that still resolves to the image it was deployed
            # with, so ECS re-pulls that rather than whatever was pushed most recently. Re-pushing a tag fails outright
            # — rebuild under a new commit instead.
            image_tag_mutability=ecr.TagMutability.IMMUTABLE,
            # Every deploy pushes a new tag and nothing is ever orphaned, so the cap is on releases rather than on
            # untagged leftovers. tag_pattern_list, not tag_prefix_list: the tag is $SHA-web / $SHA-migrate, so what
            # distinguishes them is the suffix, and prefix matching cannot express that. No rule covers untagged images.
            # Every push is tagged and IMMUTABLE, so nothing is ever orphaned into that state.
            lifecycle_rules=[
                ecr.LifecycleRule(
                    rule_priority=1,
                    tag_pattern_list=["*-web"],
                    max_image_count=RELEASES_KEPT,
                    description=f"Keep the last {RELEASES_KEPT} web images as the rollback window",
                ),
                ecr.LifecycleRule(
                    rule_priority=2,
                    tag_pattern_list=["*-migrate"],
                    max_image_count=RELEASES_KEPT,
                    description=f"Keep the last {RELEASES_KEPT} migrator images",
                ),
            ],
        )
