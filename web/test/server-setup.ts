// Env for the server-side (lib/server/**) test project.
//
// AWS credentials are dummies on purpose: presigning is local crypto, and every
// other AWS call is stubbed, so no test should reach a real endpoint.
// TEST_DATABASE_URL wins outright rather than only filling a gap: these fixtures
// TRUNCATE and deleteMany() against whatever it points at, so a developer with
// a dev database's parts exported would otherwise have it wiped. resolveDatabaseUrl()
// only reads the split DATABASE_HOST/PORT/NAME/USER/PASSWORD vars (see
// databaseUrl.ts), so a TEST_DATABASE_URL override is parsed into those parts
// rather than assigned to DATABASE_URL directly.
if (process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  process.env.DATABASE_HOST = url.hostname;
  process.env.DATABASE_PORT = url.port || "5432";
  process.env.DATABASE_NAME = url.pathname.slice(1);
  process.env.DATABASE_USER = decodeURIComponent(url.username);
  process.env.DATABASE_PASSWORD = decodeURIComponent(url.password);
}

const defaults: Record<string, string> = {
  DATABASE_HOST: "localhost",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "test",
  DATABASE_USER: "test",
  DATABASE_PASSWORD: "test",
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
