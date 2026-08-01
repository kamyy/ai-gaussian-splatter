import aws_cdk as cdk
from aws_cdk import aws_budgets as budgets
from aws_cdk import aws_cloudwatch as cloudwatch
from aws_cdk import aws_cloudwatch_actions as cloudwatch_actions
from aws_cdk import aws_sns as sns
from aws_cdk import aws_sns_subscriptions as subscriptions
from constructs import Construct


class BudgetsStack(cdk.Stack):
    """The independent, infra-level safety net (plan §5): an AWS Budget alert
    plus a CloudWatch billing alarm, deliberately separate from the
    application-level rate limiting/daily-cap logic in the backend, so a bug
    in that logic can't silently blow the budget unnoticed.
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        alert_email: str,
        monthly_budget_limit_usd: float | None = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        limit = monthly_budget_limit_usd if monthly_budget_limit_usd is not None else 25

        alert_topic = sns.Topic(self, "BillingAlertTopic")
        alert_topic.add_subscription(subscriptions.EmailSubscription(alert_email))

        budgets.CfnBudget(
            self,
            "MonthlyBudget",
            budget=budgets.CfnBudget.BudgetDataProperty(
                budget_type="COST",
                time_unit="MONTHLY",
                budget_limit=budgets.CfnBudget.SpendProperty(amount=limit, unit="USD"),
            ),
            notifications_with_subscribers=[
                budgets.CfnBudget.NotificationWithSubscribersProperty(
                    notification=budgets.CfnBudget.NotificationProperty(
                        notification_type="ACTUAL",
                        comparison_operator="GREATER_THAN",
                        threshold=80,  # 80% of budget
                        threshold_type="PERCENTAGE",
                    ),
                    subscribers=[budgets.CfnBudget.SubscriberProperty(subscription_type="EMAIL", address=alert_email)],
                ),
                budgets.CfnBudget.NotificationWithSubscribersProperty(
                    notification=budgets.CfnBudget.NotificationProperty(
                        notification_type="FORECASTED",
                        comparison_operator="GREATER_THAN",
                        threshold=100,
                        threshold_type="PERCENTAGE",
                    ),
                    subscribers=[budgets.CfnBudget.SubscriberProperty(subscription_type="EMAIL", address=alert_email)],
                ),
            ],
        )

        # Billing metrics only publish to us-east-1 — this stack must be deployed
        # there regardless of where the rest of the app runs (enforced in app.py).
        billing_alarm = cloudwatch.Alarm(
            self,
            "EstimatedChargesAlarm",
            metric=cloudwatch.Metric(
                namespace="AWS/Billing",
                metric_name="EstimatedCharges",
                dimensions_map={"Currency": "USD"},
                statistic="Maximum",
                period=cdk.Duration.hours(6),
            ),
            threshold=limit,
            evaluation_periods=1,
            comparison_operator=cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        )
        billing_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alert_topic))
