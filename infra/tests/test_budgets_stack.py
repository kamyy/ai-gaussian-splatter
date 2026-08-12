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
