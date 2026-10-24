import * as cdk from "aws-cdk-lib";
import { TabletopStack } from "../lib/tabletop-stack";

const app = new cdk.App();

// Kept out of the repo (it's public): pass with TABLETOP_ALERT_EMAIL=... or -c alertEmail=...
const alertEmail = process.env.TABLETOP_ALERT_EMAIL ?? app.node.tryGetContext("alertEmail");
if (!alertEmail) throw new Error("Set TABLETOP_ALERT_EMAIL (where budget alerts go).");

new TabletopStack(app, "Tabletop", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  repoUrl: app.node.tryGetContext("repoUrl"),
  allowedOrigins: [app.node.tryGetContext("allowedOrigin")],
  alertEmail,
  monthlyBudgetUsd: Number(app.node.tryGetContext("monthlyBudgetUsd")),
});
