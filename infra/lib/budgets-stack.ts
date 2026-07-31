import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

interface BudgetsStackProps extends cdk.StackProps {
  alertEmail: string;
  monthlyBudgetLimitUsd?: number;
}

/**
 * The independent, infra-level safety net (plan §5): an AWS Budget alert
 * plus a CloudWatch billing alarm, deliberately separate from the
 * application-level rate limiting/daily-cap logic in the backend, so a bug
 * in that logic can't silently blow the budget unnoticed.
 */
export class BudgetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BudgetsStackProps) {
    super(scope, id, props);

    const limit = props.monthlyBudgetLimitUsd ?? 25;

    const alertTopic = new sns.Topic(this, "BillingAlertTopic");
    alertTopic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));

    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: limit, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80, // 80% of budget
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
        },
      ],
    });

    // Billing metrics only publish to us-east-1 — this stack must be deployed
    // there regardless of where the rest of the app runs (enforced in bin/app.ts).
    const billingAlarm = new cloudwatch.Alarm(this, "EstimatedChargesAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/Billing",
        metricName: "EstimatedCharges",
        dimensionsMap: { Currency: "USD" },
        statistic: "Maximum",
        period: cdk.Duration.hours(6),
      }),
      threshold: limit,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    billingAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
  }
}
