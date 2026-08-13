import json

from aws_cdk.assertions import Template


def test_repository_is_not_in_the_stack_that_pulls_from_it(wired_stacks):
    """Regression test: the ECR repository must stay out of BackendStack.

    BackendStack's service is pinned to an image tag, so if the repository
    were created in the same stack it would be empty at the moment the
    service starts, the tasks would never reach a steady state, and the
    circuit breaker would roll the stack back. The repository is RETAIN, so
    it survives that rollback and then collides by name with the next attempt
    to create it — leaving a state no retry can clear.
    """
    assert Template.from_stack(wired_stacks["backend"]).find_resources("AWS::ECR::Repository") == {}

    registry = Template.from_stack(wired_stacks["registry"])
    assert len(registry.find_resources("AWS::ECR::Repository")) == 1


def test_repository_survives_stack_deletion(wired_stacks):
    """The images are the deployable artifact — tearing down the stack must
    not discard them.
    """
    template = Template.from_stack(wired_stacks["registry"])

    (repository,) = template.find_resources("AWS::ECR::Repository").values()
    assert repository["DeletionPolicy"] == "Retain"
    assert repository["Properties"]["RepositoryName"] == "ai-gaussian-splatter-backend"


def test_images_orphaned_by_the_fixed_tag_expire(wired_stacks):
    """Every push to IMAGE_TAG leaves the image it replaced behind, untagged.
    Without a lifecycle rule they accumulate for the life of the account.
    """
    template = Template.from_stack(wired_stacks["registry"])
    (props,) = template.find_resources("AWS::ECR::Repository").values()

    policy = json.loads(props["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"])
    (rule,) = policy["rules"]
    assert rule["selection"]["tagStatus"] == "untagged"
    assert props["Properties"]["ImageScanningConfiguration"] == {"ScanOnPush": True}
