# Prometheus practice build (AWS CDK)

This turns the architecture from the take-home answer into a real, deployable
stack — trimmed to stay close to the AWS Free Tier. Recommendation: deploy
this for real on your own AWS account. Reading the answer document is not
the same skill as watching CDK actually create a VPC, argue with an IAM
policy, or show you a target group stuck in `unhealthy`. That hands-on
friction is what you'll be asked to speak to on Monday.

## What this deploys

| Piece | Answer doc | This stack | Notes |
|---|---|---|---|
| Compute | ECS Fargate | ECS Fargate (2 tasks, 0.25 vCPU/0.5GB each) | Matches the answer doc exactly. **No free tier** — bills per vCPU/GB-second from the moment a task is running, roughly $0.02–0.03/hr for 2 tasks. Trivial for a short session, covered by credits, but never becomes free like EC2 does. |
| NAT | 1 per AZ | 1 total | NAT Gateways bill per-hour + per-GB regardless of tier — the single biggest cost lever. Trade-off: an AZ failure in the NAT's own AZ takes outbound internet from *both* AZs' app tier (Fargate needs egress to pull its image and reach ECR/CloudWatch). Say this out loud in your debrief. |
| RDS | Multi-AZ | Single-AZ | Multi-AZ isn't free-tier eligible; Single-AZ db.t3.micro is. Flip `multiAz: false` → `true` in the stack for the "real" answer. |
| Everything else (VPC/subnet layout, SG chaining, IAM least-privilege split between task role and execution role, ALB health checks, CloudWatch alarms → SNS) | — | Same as the doc | These don't cost anything extra to do properly. |

## Cost reality check

Nothing here is fully free — this is a real, billed environment, just a very cheap one for a short session:
- **Fargate**: ~$0.02–0.03/hr for 2 tasks at the smallest size. No free tier at any point — this is the one line item that differs fundamentally from the EC2 version.
- **ALB**: ~$0.0225/hr + LCU usage — a few cents for a couple of hours of testing.
- **NAT Gateway**: ~$0.045/hr + data — also a few cents for a short session.
- RDS db.t3.micro Single-AZ: free tier eligible (first 12 months / new accounts).

Total for a 2–3 hour test-and-tear-down session: **still well under $1**, and your $200 sign-up credits absorb it automatically. The risk is the same as before — leaving it running. Fargate in particular never "becomes free" the way EC2 does at the 750-hr/month free-tier threshold, so the destroy step below matters even more here.

## Prerequisites

- An AWS account with an IAM user/role that has admin or near-admin rights (this is a personal sandbox, so that's fine — never do this against a shared/company account).
- AWS CLI configured (`aws configure`) with that account's credentials.
- Node.js 18+ and npm.
- AWS CDK CLI: `npm install -g aws-cdk` (or just use `npx cdk` — this project's `package.json` already lists `aws-cdk` as a dev dependency).

## Setup

```bash
cd prometheus-cdk
npm install

# One-time per account/region:
npx cdk bootstrap

# See exactly what CloudFormation will create, with no side effects:
npx cdk synth
```

Before deploying, lock the ALB down to your own IP rather than the whole
internet:

```bash
curl -s ifconfig.me   # copy the IP it prints
npx cdk deploy --context myIpCidr=YOUR_IP/32
```

If you want alarm emails, add `--context alertEmail=you@example.com`
(you'll get a confirmation email from SNS to accept first).

Deploy takes roughly 8–12 minutes — most of it is the RDS instance and the
NAT Gateway coming up. Read the CDK diff it shows you before typing `y`;
that's a real part of the job.

## Test it

```bash
# From the CfnOutput printed at the end of `cdk deploy`:
curl http://<AlbDnsName>/
curl http://<AlbDnsName>/healthz
```

You should see the demo HTML page and `ok`.

## Practice the troubleshooting scenario, for real

The brief's Part 2 asks how you'd debug "intermittent timeouts, CPU/memory
normal." You can actually reproduce something in that family here instead
of just describing it from memory:

1. **Health-check flapping**: temporarily lower `unhealthyThresholdCount`
   to `1` and shorten `interval`, redeploy, then use ECS Exec to shell
   into a running task and kill the container's process. Watch the
   target group mark it unhealthy and the service replace the task —
   this is exactly "check target health first" from the answer doc,
   except now you're looking at a real console instead of describing one.
2. **Connection pool exhaustion**: swap the placeholder nginx image for a
   tiny Flask/Node app with a small DB connection pool, scale the service
   up, and watch RDS `DatabaseConnections` climb in CloudWatch.
3. **NAT port exhaustion**: check the `ErrorPortAllocation` metric on the
   NAT Gateway in CloudWatch — it'll be zero here, which is itself worth
   knowing how to confirm.

Shell into a running task with ECS Exec (needs `enableExecuteCommand: true`
added to the service — add it if you want to try this):

```bash
aws ecs execute-command --cluster <ClusterName> --task <task-id> \
  --container AppContainer --interactive --command "/bin/sh"
```

## Tear down (don't skip this)

```bash
npx cdk destroy
```

Confirm in the AWS Console under CloudFormation that the stack shows
`DELETE_COMPLETE`, and double-check the ECS, RDS, and VPC (NAT Gateway)
consoles directly — CDK/CloudFormation deletion is generally clean here
since `removalPolicy: DESTROY` is set on the DB, but it's a good habit to
verify rather than assume, especially the NAT Gateway since it's the
highest hourly cost item if it's ever orphaned.

## What to say Monday

You've now got a live CloudFormation stack (via `cdk diff`/console),
real IAM policies you can open and point to, real CloudWatch alarms, and
two documented, cost-driven deviations from your written answer that you
chose deliberately and can defend. That's a stronger position than
"I re-read my document."
