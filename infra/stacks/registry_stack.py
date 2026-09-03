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

    Separate from WebStack so the repository can be created and populated
    before the ECS service exists: the service names an image tag, so a
    combined stack's first deploy would have nothing to pull and the circuit
    breaker would roll it back.
    """

    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        self.repository = ecr.Repository(
            self,
            "WebRepository",
            # Repository holds both build targets of web/Dockerfile, distinguished by tag's -web/-migrate suffix.
            repository_name="ai-gaussian-splatter",
            # DESTROY, not RETAIN: a full `cdk destroy --all` (see RUNBOOK.md's Tearing down) must not leave an
            # orphaned repository behind. An orphan under this same fixed name would block the next
            # `cdk deploy RegistryStack` with a plain "repository already exists" failure that no retry clears.
            # empty_on_delete is required alongside it: ECR itself refuses to delete a non-empty repository, so
            # without it the stack would get stuck in DELETE_FAILED on every image pushed since the last deploy.
            removal_policy=cdk.RemovalPolicy.DESTROY,
            empty_on_delete=True,
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
