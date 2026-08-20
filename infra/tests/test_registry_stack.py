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
    """The images are the deployable artifact — tearing down the stack must
    not discard them.
    """
    template = Template.from_stack(wired_stacks["registry"])

    (repository,) = template.find_resources("AWS::ECR::Repository").values()
    assert repository["DeletionPolicy"] == "Retain"
    assert repository["Properties"]["RepositoryName"] == "ai-gaussian-splatter-web"


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
    """Each deploy pushes its own tag, so without a cap they accumulate for the
    life of the account. The retained ones are the rollback window: any of them
    can be redeployed by passing its tag back to -c imageTag=.
    """
    template = Template.from_stack(wired_stacks["registry"])
    (props,) = template.find_resources("AWS::ECR::Repository").values()

    policy = json.loads(props["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"])
    (rule,) = policy["rules"]
    assert rule["action"] == {"type": "expire"}
    assert rule["selection"]["countNumber"] == RELEASES_KEPT
