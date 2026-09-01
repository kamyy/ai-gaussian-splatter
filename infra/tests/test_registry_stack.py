import json

from aws_cdk.assertions import Template

from stacks.registry_stack import RELEASES_KEPT


def test_repository_is_not_in_the_stack_that_pulls_from_it(wired_stacks):
    """Regression test: the ECR repository must stay out of WebStack.

    WebStack's service is pinned to an image tag, so if the repository
    were created in the same stack it would be empty at the moment the
    service starts, the tasks would never reach a steady state, and the
    circuit breaker would roll the stack back. The repository is RETAIN, so
    it survives that rollback and then collides by name with the next attempt
    to create it — leaving a state no retry can clear.
    """
    assert Template.from_stack(wired_stacks["web"]).find_resources("AWS::ECR::Repository") == {}

    registry = Template.from_stack(wired_stacks["registry"])
    assert len(registry.find_resources("AWS::ECR::Repository")) == 1


def test_repository_survives_stack_deletion(wired_stacks):
    """The images are the deployable artifact. Tearing down the stack must
    not discard them.
    """
    template = Template.from_stack(wired_stacks["registry"])

    (repository,) = template.find_resources("AWS::ECR::Repository").values()
    assert repository["DeletionPolicy"] == "Retain"
    assert repository["Properties"]["RepositoryName"] == "ai-gaussian-splatter"


def test_pushed_tags_can_never_be_repointed(wired_stacks):
    """Immutable tags are what make the deployment circuit breaker's rollback
    mean anything. If a tag could be repushed, the previous task definition
    would name a string that now resolves to the newest image, so a rollback
    would re-pull the build that just failed its health checks.
    """
    template = Template.from_stack(wired_stacks["registry"])
    (props,) = template.find_resources("AWS::ECR::Repository").values()

    assert props["Properties"]["ImageTagMutability"] == "IMMUTABLE"
    assert props["Properties"]["ImageScanningConfiguration"] == {"ScanOnPush": True}


def test_a_bounded_number_of_releases_is_kept(wired_stacks):
    """Each deploy pushes two tags now ($SHA-web and $SHA-migrate, see
    web/Dockerfile), so without a cap they accumulate for the life of the
    account.

    A rule per suffix rather than one over both, since each release pushes
    one of each and a single cap would therefore keep half as many releases.
    Both budgets are the same because a rollback to $SHA re-points
    MigrationTaskDefinition at $SHA-migrate as well (infra/stacks/registry_stack.py).
    Matching is by suffix, which needs tagPatternList. Prefix matching cannot
    express it.
    """
    template = Template.from_stack(wired_stacks["registry"])
    (props,) = template.find_resources("AWS::ECR::Repository").values()

    policy = json.loads(props["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"])
    rules = {rule["selection"]["tagPatternList"][0]: rule for rule in policy["rules"]}

    assert set(rules) == {"*-web", "*-migrate"}
    for rule in rules.values():
        assert rule["action"] == {"type": "expire"}
        assert rule["selection"]["tagStatus"] == "tagged"

    # Both suffixes to the same depth: an expired image of either kind is a CannotPullContainerError on the next task
    # placement that names its SHA.
    assert rules["*-web"]["selection"]["countNumber"] == RELEASES_KEPT
    assert rules["*-migrate"]["selection"]["countNumber"] == RELEASES_KEPT
