# Runtime settings: operational values that can change without a deploy.
#
# Each setting is an SSM Parameter Store parameter under local.settings_path. The web service reads them all at request
# time with a short cache (web/lib/server/runtimeSettings.ts), so a change made with scripts/prod/ssm-set.sh takes
# effect within a minute. They are parameters rather than Secrets Manager secrets because none of them is secret, and
# standard parameters are free.
#
# Terraform creates each parameter with its initial value from local.runtime_settings and then ignores the value. An
# apply would otherwise reset every setting someone had tuned since.

resource "aws_ssm_parameter" "runtime_setting" {
  for_each = local.runtime_settings

  name  = "${local.settings_path}/${each.key}"
  type  = "String"
  value = each.value

  lifecycle {
    ignore_changes = [value]
  }
}
