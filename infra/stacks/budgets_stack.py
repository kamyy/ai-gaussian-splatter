import aws_cdk as cdk
from aws_cdk import aws_budgets as budgets
from aws_cdk import aws_cloudwatch as cloudwatch
from aws_cdk import aws_cloudwatch_actions as cloudwatch_actions
from aws_cdk import aws_iam as iam
from aws_cdk import aws_kms as kms
from aws_cdk import aws_sns as sns
from aws_cdk import aws_sns_subscriptions as subscriptions
from constructs import Construct


class BudgetsStack(cdk.Stack):
    """The independent, infra-level safety net: an AWS Budget alert
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

        # Must stay above the stack's own fixed monthly cost (~$35: ALB, RDS,
        # one Fargate Spot task, secrets, logs) or both notifications fire
        # every month regardless of usage and the alert stops meaning
        # anything. Below the ~$110/month that GLOBAL_MAX_JOBS_PER_DAY would
        # allow, so it still catches the runaway case it exists to bound.
        limit = monthly_budget_limit_usd if monthly_budget_limit_usd is not None else 75

        # A customer-managed key, not the alias/aws/sns default: the default's
        # policy can't be edited, and it doesn't let CloudWatch call
        # kms:GenerateDataKey — the alarm below would then fail its action with
        # "CloudWatch Alarms does not have authorization to access the SNS
        # topic encryption key" and silently never notify. Costs $1/month,
        # which is the price of encrypting the one channel that reports how
        # much this account is spending.
        alert_key = kms.Key(
            self,
            "BillingAlertKey",
            description="Encrypts the billing alert SNS topic",
            enable_key_rotation=True,
        )
        alert_key.add_to_resource_policy(
            iam.PolicyStatement(
                principals=[iam.ServicePrincipal("cloudwatch.amazonaws.com")],
                actions=["kms:Decrypt", "kms:GenerateDataKey*"],
                resources=["*"],
            )
        )

        alert_topic = sns.Topic(self, "BillingAlertTopic", master_key=alert_key)
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
            # EstimatedCharges publishes nothing at all until "Receive Billing
            # Alerts" is switched on in the account's billing preferences (a
            # console-only setting — see RUNBOOK.md). Stated explicitly so the
            # no-data case reads as "not wired up yet" rather than as an alarm.
            treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
        )
        billing_alarm.add_alarm_action(cloudwatch_actions.SnsAction(alert_topic))
