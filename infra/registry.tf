# The ECR repository holding the web/ container image. Deliberately created before the ECS service ever
# references an image tag: a first apply that tried to create both at once would leave the service with
# nothing to pull, tripping the deployment circuit breaker.
#
# Each deploy pushes two immutable tags, $SHA-web and $SHA-migrate (see web/Dockerfile), capped by a lifecycle
# rule per suffix so RELEASES_KEPT below is a count of releases rather than of images.
resource "aws_ecr_repository" "web" {
  name                 = "ai-gaussian-splatter"
  image_tag_mutability = "IMMUTABLE"

  # A tag, once pushed, can never be repointed. This is what makes the deployment circuit breaker's rollback
  # mean anything: the previous task definition names a tag that still resolves to the image it was deployed
  # with, so ECS re-pulls that rather than whatever was pushed most recently. Re-pushing a tag fails outright —
  # rebuild under a new commit instead.

  # force_delete, not RETAIN: a full `terraform destroy` must not leave an orphaned repository under this fixed
  # name — an orphan would block the next apply with a plain "repository already exists" failure that no retry
  # clears. ECR itself refuses to delete a non-empty repository, so this is required alongside the fixed name,
  # not just alongside destroy.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# An ECR lifecycle rule cannot see ECS: it expires by push date alone, so a tag the service is currently
# running is eligible once enough newer images exist. Running tasks survive that, having already pulled. The
# next placement (a Spot reclaim, a scale-out, or the circuit breaker's own rollback) fails with
# CannotPullContainerError. The exposure is real after a rollback, where the live tag is deliberately an old
# one, so RELEASES_KEPT is the number that protects it. Rolling back also re-points the migration task
# definition at the matching -migrate tag, so both of a release's tags are kept to the same depth.
resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last ${local.releases_kept} web images as the rollback window"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*-web"]
          countType      = "imageCountMoreThan"
          countNumber    = local.releases_kept
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${local.releases_kept} migrator images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*-migrate"]
          countType      = "imageCountMoreThan"
          countNumber    = local.releases_kept
        }
        action = { type = "expire" }
      },
    ]
  })
}

# A separate repository, not a third tag suffix on the one above: the worker image is a completely different
# build (~19 GB of COLMAP + gsplat) with no reason to share the web repository's retention depth. It isn't part
# of any ECS rollback mechanism either — web/lib/server/ec2Launcher.ts just reads whatever WORKER_IMAGE_URI
# currently points to — so worker_releases_kept (locals.tf) is far shallower than releases_kept. GPU worker
# deployment stays manual (RUNBOOK.md), so nothing pushes here automatically.
resource "aws_ecr_repository" "worker" {
  name                 = "ai-gaussian-splatter-worker"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last ${local.worker_releases_kept} worker images"
      selection = {
        tagStatus      = "tagged"
        tagPatternList = ["*"]
        countType      = "imageCountMoreThan"
        countNumber    = local.worker_releases_kept
      }
      action = { type = "expire" }
    }]
  })
}
