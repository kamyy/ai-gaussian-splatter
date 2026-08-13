import json

import aws_cdk as cdk
from aws_cdk.assertions import Match, Template

from app import build_stacks
from tests.conftest import CDK_JSON, ENV


def test_terminate_instances_scoped_to_worker_tag(wired_stacks):
    """The Role=worker tag condition is a cross-stack contract shared with
    backend_stack.py's RunInstances grant — both must stay in sync.
    """
    template = Template.from_stack(wired_stacks["worker_iam"])

    template.has_resource_properties(
        "AWS::IAM::Policy",
        {
            "PolicyDocument": {
                "Statement": Match.array_with(
                    [
                        Match.object_like(
                            {
                                "Action": "ec2:TerminateInstances",
                                "Effect": "Allow",
                                "Resource": "*",
                                "Condition": {"StringEquals": {"ec2:ResourceTag/Role": "worker"}},
                            }
                        )
                    ]
                )
            }
        },
    )


def test_spot_service_linked_role_is_declared(wired_stacks):
    """EC2 creates AWSServiceRoleForEC2Spot on its own only for a request made
    in the console. ec2Launcher.ts asks through the API, where the role has to
    already exist — so the stack has to bring it.
    """
    template = Template.from_stack(wired_stacks["worker_iam"])
    template.has_resource_properties(
        "AWS::IAM::ServiceLinkedRole",
        {"AWSServiceName": "spot.amazonaws.com"},
    )


def test_spot_service_linked_role_survives_a_stack_delete(wired_stacks):
    """The role is one account-wide singleton shared with every other Spot
    workload — CloudFormation deleting it would break all of them.
    """
    template = Template.from_stack(wired_stacks["worker_iam"])
    (resource,) = template.find_resources("AWS::IAM::ServiceLinkedRole").values()
    assert resource["DeletionPolicy"] == "Retain"


def test_spot_service_linked_role_can_be_opted_out(wired_stacks):
    """An account that already has the role can't create a second one, so the
    deploy needs a way past it that isn't deleting the existing role.
    """
    app = cdk.App(context={**json.loads(CDK_JSON.read_text())["context"], "createSpotServiceLinkedRole": "false"})
    stacks = build_stacks(
        app,
        ENV,
        worker_ami_id="ami-000000000000",
        alert_email="kam.yin.yip@gmail.com",
        app_public_url="https://ai-gaussian-splatter.orky.net",
        hosted_zone_id="Z00000000000000000000",
    )
    template = Template.from_stack(stacks["worker_iam"])
    assert template.find_resources("AWS::IAM::ServiceLinkedRole") == {}
