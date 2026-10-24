#!/usr/bin/env bash
# Deploy the latest main to the server: pull, npm ci, restart. Runs over SSM (no SSH).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # stop Git Bash rewriting /usr/... paths

ID=$(aws cloudformation describe-stacks --region us-east-1 --stack-name Tabletop \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
echo "Updating $ID…"
CMD=$(aws ssm send-command --region us-east-1 --instance-ids "$ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/bin/tabletop-update"]' --query Command.CommandId --output text)
aws ssm wait command-executed --region us-east-1 --command-id "$CMD" --instance-id "$ID" || true
aws ssm get-command-invocation --region us-east-1 --command-id "$CMD" --instance-id "$ID" \
  --query "[Status, StandardOutputContent, StandardErrorContent]" --output text
