#!/usr/bin/env bash
# Creates the GitHub OIDC provider and the ai-gaussian-splatter-ci-deploy role .github/workflows/deploy.yml assumes.
# Safe to re-run. Both of the role's policies are rewritten from this file on every run, so fixing an AccessDenied from
# the deploy job is an edit to DEPLOY_POLICY below and a re-run.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

ROLE=ai-gaussian-splatter-ci-deploy
OIDC_HOST=token.actions.githubusercontent.com
PROJECT_TAG=$(tf_get_local project_tag)
REGION=$(tf_get_aws_region)

aws_require_login
gh_require_login

# {owner}/{repo} are gh's own placeholders, resolved from this checkout's origin remote.
REPO_NAME=$(gh api 'repos/{owner}/{repo}' --jq .full_name)
# The form of the token's sub claim depends on the repository's OIDC subject setting. With immutable subjects on it is
# repo:OWNER@OWNER_ID/REPO@REPO_ID, and otherwise repo:OWNER/REPO. IAM's StringEquals is exact, and every run rewrites
# the trust policy, so the prefix comes from GitHub rather than being assumed.
SUB_PREFIX=$(gh api 'repos/{owner}/{repo}/actions/oidc/customization/sub' --jq .sub_claim_prefix)
if [[ $SUB_PREFIX != repo:* ]]; then
  echo "GitHub reported no usable OIDC sub claim prefix for $REPO_NAME: $SUB_PREFIX" >&2
  exit 1
fi
SUBJECT="$SUB_PREFIX:ref:refs/heads/main"

confirm "Create or update the $ROLE role in account $AWS_ACCOUNT_ID, trusting $SUBJECT?"

# IAM allows only one OIDC provider per URL per account, and a repeat create fails with EntityAlreadyExists. If another
# app in this account created it already, reuse it. Only this app's role and its trust policy are new.
PROVIDERS=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text)
if [[ $PROVIDERS != *"oidc-provider/$OIDC_HOST"* ]]; then
  # No --thumbprint-list: IAM validates GitHub's TLS cert against its own trusted root CA library first, since GitHub's
  # OIDC endpoint chains to a public CA, and only falls back to thumbprint matching when it doesn't.
  aws iam create-open-id-connect-provider --url "https://$OIDC_HOST" --client-id-list sts.amazonaws.com >/dev/null
fi

TRUST_POLICY=$(
  cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::$AWS_ACCOUNT_ID:oidc-provider/$OIDC_HOST"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "$OIDC_HOST:aud": "sts.amazonaws.com",
        "$OIDC_HOST:sub": "$SUBJECT"
      }
    }
  }]
}
EOF
)

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST_POLICY"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST_POLICY" >/dev/null
fi

aws iam tag-role --role-name "$ROLE" --tags "Key=Project,Value=$PROJECT_TAG"

DEPLOY_POLICY=$(
  cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:PutImage", "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        "ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories",
        "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:TagResource", "ecr:PutImageTagMutability"
      ], "Resource": "arn:aws:ecr:$REGION:$AWS_ACCOUNT_ID:repository/ai-gaussian-splatter*"},
    {"Effect": "Allow", "Action": "ecs:RunTask", "Resource": [
        "arn:aws:ecs:$REGION:$AWS_ACCOUNT_ID:task-definition/ai-gaussian-splatter-migrate:*",
        "arn:aws:ecs:$REGION:$AWS_ACCOUNT_ID:cluster/ai-gaussian-splatter"
      ]},
    {"Effect": "Allow", "Action": ["ecs:DescribeTasks", "ecs:DescribeServices"], "Resource": "*",
      "Condition": {"ArnEquals": {
        "ecs:cluster": "arn:aws:ecs:$REGION:$AWS_ACCOUNT_ID:cluster/ai-gaussian-splatter"
      }}},
    {"Effect": "Allow", "Action": [
        "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition",
        "ecs:CreateCluster", "ecs:DeleteCluster", "ecs:DescribeClusters", "ecs:PutClusterCapacityProviders",
        "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:TagResource",
        "ecs:PutAccountSetting", "ecs:ListTagsForResource"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "application-autoscaling:RegisterScalableTarget", "application-autoscaling:DeregisterScalableTarget",
        "application-autoscaling:PutScalingPolicy", "application-autoscaling:DeleteScalingPolicy",
        "application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": "iam:PassRole", "Resource": [
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-execution",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-migrate-task",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-task",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-worker"
      ]},
    {"Effect": "Allow", "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies",
        "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile"
      ], "Resource": [
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-*",
        "arn:aws:iam::$AWS_ACCOUNT_ID:instance-profile/ai-gaussian-splatter-*"
      ]},
    {"Effect": "Allow", "Action": [
        "s3:CreateBucket", "s3:DeleteBucket*", "s3:ListBucket", "s3:GetBucket*", "s3:PutBucket*",
        "s3:PutObject", "s3:GetObject", "s3:DeleteObject",
        "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration",
        "s3:PutLifecycleConfiguration", "s3:GetLifecycleConfiguration"
      ], "Resource": [
        "arn:aws:s3:::ai-gaussian-splatter-*", "arn:aws:s3:::ai-gaussian-splatter-*/*"
      ]},
    {"Effect": "Allow", "Action": [
        "ec2:CreateVpc", "ec2:DeleteVpc", "ec2:DescribeVpcs", "ec2:ModifyVpcAttribute",
        "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:DescribeSubnets", "ec2:ModifySubnetAttribute",
        "ec2:CreateInternetGateway", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway", "ec2:DescribeInternetGateways",
        "ec2:CreateRouteTable", "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:DeleteRoute",
        "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:DescribeRouteTables",
        "ec2:CreateVpcEndpoint", "ec2:DeleteVpcEndpoints", "ec2:DescribeVpcEndpoints",
        "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:DescribeSecurityGroups",
        "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress",
        "ec2:DescribeSecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
        "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
        "ec2:CreateTags", "ec2:DeleteTags", "ec2:DescribeTags", "ec2:DescribeAvailabilityZones"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "rds:CreateDBInstance", "rds:DeleteDBInstance", "rds:ModifyDBInstance", "rds:DescribeDBInstances",
        "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:DescribeDBSubnetGroups",
        "rds:AddTagsToResource", "rds:ListTagsForResource"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:CreateListener", "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:AddTags", "elasticloadbalancing:DescribeTags"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "route53:ChangeResourceRecordSets", "route53:GetHostedZone", "route53:ListResourceRecordSets",
        "route53:GetChange"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "acm:RequestCertificate", "acm:DeleteCertificate", "acm:DescribeCertificate", "acm:AddTagsToCertificate"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "budgets:ViewBudget", "budgets:ModifyBudget"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups", "logs:PutRetentionPolicy",
        "logs:TagResource"
      ], "Resource": "arn:aws:logs:$REGION:$AWS_ACCOUNT_ID:log-group:/ecs/ai-gaussian-splatter-*"},
    {"Effect": "Allow", "Action": ["secretsmanager:CreateSecret", "secretsmanager:TagResource"],
      "Resource": "arn:aws:secretsmanager:$REGION:$AWS_ACCOUNT_ID:secret:rds!*"},
    {"Effect": "Allow", "Action": "kms:DescribeKey", "Resource": "arn:aws:kms:$REGION:$AWS_ACCOUNT_ID:key/*"},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], "Resource": [
        "arn:aws:s3:::ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID",
        "arn:aws:s3:::ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID/*"
      ]}
  ]
}
EOF
)

aws iam put-role-policy --role-name "$ROLE" --policy-name deploy --policy-document "$DEPLOY_POLICY"

echo "Role ready: arn:aws:iam::$AWS_ACCOUNT_ID:role/$ROLE. Next: scripts/prod/set-gh-repo-variables.sh"
