// Env for the server-side (lib/server/**) test project, replacing what
// backend/tests/conftest.py used to set before importing any `app.*` module.
//
// AWS credentials are dummies on purpose: presigning is local crypto (no
// network), and every other AWS call is stubbed by aws-sdk-client-mock, so no
// test should ever reach a real endpoint.
// TEST_DATABASE_URL wins outright rather than only filling a gap. These tests
// TRUNCATE and deleteMany() against whatever DATABASE_URL points at, and
// server-global-setup.ts migrates TEST_DATABASE_URL — so if a developer has a
// dev DATABASE_URL exported, `??=` below would have pointed the destructive
// fixtures at their dev database while migrating a different one.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const defaults: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  UPLOADS_BUCKET: "test-uploads",
  SPLATS_BUCKET: "test-splats",
  AWS_REGION: "us-west-2",
  AWS_ACCESS_KEY_ID: "testing",
  AWS_SECRET_ACCESS_KEY: "testing",
  WORKER_AMI_ID: "ami-0123456789",
  WORKER_SUBNET_ID: "subnet-0123456789",
  WORKER_SECURITY_GROUP_ID: "sg-0123456789",
  WORKER_INSTANCE_PROFILE_ARN: "arn:aws:iam::123456789012:instance-profile/worker",
  APP_PUBLIC_URL: "https://app.example.com",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
