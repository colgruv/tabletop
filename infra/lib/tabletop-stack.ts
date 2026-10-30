import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { serverUserData } from "./user-data";

export interface TabletopStackProps extends cdk.StackProps {
  /** Public git URL the server clones and pulls from. */
  repoUrl: string;
  /** Browser origin(s) allowed to call the API, e.g. https://colgruv.github.io */
  allowedOrigins: string[];
  /** Where budget alerts are emailed. */
  alertEmail: string;
  monthlyBudgetUsd: number;
}

const PORT = 8787;
/** Amazon Linux 2023, arm64, as deployed on 2026-10-24. */
const SERVER_AMI = "ami-08eb58865930c986c";

/**
 * Test-scale backend: one small EC2 instance running server/ with SQLite on
 * its disk, behind CloudFront for HTTPS. See AGENTS.md section 5.
 *
 *   browser --HTTPS--> CloudFront --HTTP :8787--> EC2 (only CloudFront may connect)
 */
export class TabletopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TabletopStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });

    // Only CloudFront's origin-facing IPs may reach the server. No SSH: use SSM Session Manager.
    const cloudFrontIps = ec2.PrefixList.fromLookup(this, "CloudFrontOriginFacing", {
      prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
    });
    const sg = new ec2.SecurityGroup(this, "ServerSg", {
      vpc,
      description: "Tabletop server: CloudFront only",
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.prefixList(cloudFrontIps.prefixListId), ec2.Port.tcp(PORT), "CloudFront to API");

    const role = new iam.Role(this, "ServerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    // OAuth settings live in Parameter Store under /tabletop/ (created by hand, since the
    // secrets must not pass through the repo). The server reads them at startup. Secure
    // strings use the default aws/ssm key, which needs no separate KMS grant.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"],
        resources: [
          cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: "tabletop", arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME }, this),
          cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: "tabletop/*", arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME }, this),
        ],
      }),
    );

    const instance = new ec2.Instance(this, "Server", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType("t4g.micro"),
      // Pinned so a new AMI never silently replaces the instance (which would lose
      // the SQLite file). Changing this replaces the server: restore from a snapshot.
      machineImage: ec2.MachineImage.genericLinux({ "us-east-1": SERVER_AMI }),
      securityGroup: sg,
      role,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      propagateTagsToVolumeOnCreation: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(10, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
      userData: serverUserData({ repoUrl: props.repoUrl, port: PORT, allowedOrigins: props.allowedOrigins }),
    });
    cdk.Tags.of(instance).add("tabletop-backup", "daily");

    // A stable address. CloudFront needs a hostname, so use the EIP's EC2 public DNS name.
    const eip = new ec2.CfnEIP(this, "ServerIp", { domain: "vpc", instanceId: instance.instanceId });
    const originHost = cdk.Fn.join("", [
      "ec2-",
      cdk.Fn.join("-", cdk.Fn.split(".", eip.attrPublicIp, 4)),
      `.compute-1.amazonaws.com`,
    ]);

    const distribution = new cloudfront.Distribution(this, "Api", {
      comment: "Tabletop API",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.HttpOrigin(originHost, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: PORT,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Polls must reach the server (it answers 304 itself via ETag).
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forwards query strings, Origin (CORS), and If-None-Match.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });
    distribution.node.addDependency(eip);

    // Daily snapshots of the instance's disk (including the event log), keep 7.
    const snapshotRole = new iam.Role(this, "SnapshotRole", {
      assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole"),
      ],
    });
    new dlm.CfnLifecyclePolicy(this, "DailySnapshots", {
      description: "Tabletop server daily snapshots",
      state: "ENABLED",
      executionRoleArn: snapshotRole.roleArn,
      policyDetails: {
        resourceTypes: ["INSTANCE"],
        targetTags: [{ key: "tabletop-backup", value: "daily" }],
        schedules: [
          {
            name: "daily",
            createRule: { interval: 24, intervalUnit: "HOURS", times: ["07:00"] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });

    // Covers the whole AWS account, not just this stack.
    const subscribers = [{ subscriptionType: "EMAIL", address: props.alertEmail }];
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "tabletop-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
          subscribers,
        },
        {
          notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
          subscribers,
        },
      ],
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
  }
}
