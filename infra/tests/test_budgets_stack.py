from aws_cdk.assertions import Match, Template


def test_budget_has_both_notification_thresholds(wired_stacks):
    template = Template.from_stack(wired_stacks["budgets"])

    template.has_resource_properties(
        "AWS::Budgets::Budget",
        {
            "Budget": Match.object_like(
                {
                    "BudgetType": "COST",
                    "TimeUnit": "MONTHLY",
                    "BudgetLimit": {"Amount": 75, "Unit": "USD"},
                }
            ),
            "NotificationsWithSubscribers": Match.array_with(
                [
                    Match.object_like(
                        {
                            "Notification": Match.object_like(
                                {
                                    "NotificationType": "ACTUAL",
                                    "ComparisonOperator": "GREATER_THAN",
                                    "Threshold": 80,
                                    "ThresholdType": "PERCENTAGE",
                                }
                            )
                        }
                    ),
                    Match.object_like(
                        {
                            "Notification": Match.object_like(
                                {
                                    "NotificationType": "FORECASTED",
                                    "ComparisonOperator": "GREATER_THAN",
                                    "Threshold": 100,
                                    "ThresholdType": "PERCENTAGE",
                                }
                            )
                        }
                    ),
                ]
            ),
        },
    )


def test_billing_alarm_config(wired_stacks):
    template = Template.from_stack(wired_stacks["budgets"])

    template.has_resource_properties(
        "AWS::CloudWatch::Alarm",
        {
            "Namespace": "AWS/Billing",
            "MetricName": "EstimatedCharges",
            "Statistic": "Maximum",
            "Period": 21600,
            "Threshold": 75,
            "EvaluationPeriods": 1,
            "ComparisonOperator": "GreaterThanThreshold",
        },
    )


def test_alarm_can_actually_publish_to_the_encrypted_topic(wired_stacks):
    """The alias/aws/sns default key has an uneditable policy that omits
    CloudWatch, so the alarm would fail its action and notify nobody — the one
    failure this stack exists to prevent.
    """
    template = Template.from_stack(wired_stacks["budgets"])
    (key,) = template.find_resources("AWS::KMS::Key").values()

    grants = [
        statement
        for statement in key["Properties"]["KeyPolicy"]["Statement"]
        if statement.get("Principal", {}).get("Service") == "cloudwatch.amazonaws.com"
    ]
    assert len(grants) == 1
    assert set(grants[0]["Action"]) == {"kms:Decrypt", "kms:GenerateDataKey*"}


def test_missing_billing_data_is_not_an_alarm(wired_stacks):
    """EstimatedCharges publishes nothing until the account's billing-alerts
    preference is switched on, which is a console-only setting.
    """
    template = Template.from_stack(wired_stacks["budgets"])
    template.has_resource_properties("AWS::CloudWatch::Alarm", {"TreatMissingData": "notBreaching"})
