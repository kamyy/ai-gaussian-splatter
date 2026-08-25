# Shared cross-stack contract between web_stack.py's ec2:RunInstances/ TerminateInstances grants and
# worker_iam_stack.py's self-termination grant — both scope their EC2 permissions to instances carrying this tag, since
# EC2 has no native "restrict to the calling instance" condition. A single source of truth here instead of the same
# string duplicated in both files, which drifting apart would silently break scoping.
WORKER_TAG_KEY = "Role"
WORKER_TAG_VALUE = "worker"
