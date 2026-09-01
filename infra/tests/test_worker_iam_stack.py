from aws_cdk.assertions import Match, Template


def test_terminate_instances_scoped_to_worker_tag(wired_stacks):
    """The Role=worker tag condition is a cross-stack contract shared with
    infra/stacks/web_stack.py's RunInstances grant. Both must stay in sync.
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
